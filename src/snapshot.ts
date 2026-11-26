// Snapshot (issue #3): which project files enter the container, in what order, and their tree hash.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { readBounded, type Config } from "./config.ts";
import { padding, sha256, tarHeader, TAR_END } from "./protocol.ts";

export class SnapshotError extends Error {
  constructor(message: string, readonly next: string) { super(message); }
}

// Never sent, whatever .atexignore says (AGENTS.md: secrets and .git never enter the snapshot).
const SECRETS = [".git", ".env*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ecdsa*", "id_ed25519*", ".npmrc", ".netrc"];
const DEFAULTS = ["node_modules", ...["aux", "log", "fls", "fdb_latexmk", "synctex.gz", "out", "toc", "nav", "snm", "vrb", "blg", "bcf", "run.xml"].map(ext => `*.${ext}`)];

interface Rule { glob: Bun.Glob; negate: boolean; dirOnly: boolean }

// ponytail: gitignore subset on Bun.Glob (no escapes or character-class edge cases); add a full matcher if users need it.
export function rule(line: string): Rule | null {
  let p = line.trim();
  if (!p || p.startsWith("#")) return null;
  const negate = p.startsWith("!");
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  return { glob: new Bun.Glob(anchored ? p : `**/${p}`), negate, dirOnly };
}

const rules = (lines: string[]) => lines.map(rule).filter((r): r is Rule => r !== null);
const SECRET_RULES = rules(SECRETS);

/** True when the path or any directory above it matches a secret pattern. */
export function secret(rel: string): boolean {
  const parts = rel.split("/");
  return parts.some((_, i) => { const prefix = parts.slice(0, i + 1).join("/"); return SECRET_RULES.some(r => r.glob.match(prefix)); });
}

/** Last matching rule wins; secrets cannot be re-included. */
export function excluded(rel: string, isDir: boolean, list: Rule[]): boolean {
  if (secret(rel)) return true;
  let out = false;
  for (const r of list) if ((!r.dirOnly || isDir) && r.glob.match(rel)) out = !r.negate;
  return out;
}

// `path` is the canonical file scanned; stream reopens it without following links and checks it is the same file.
export interface Entry { name: string; path: string; size: number; dev: number; ino: number }
export interface Snapshot { entries: Entry[]; bytes: number }

/** Walk the root and the extras. Fails before any container starts on caps, escaping links or special files. */
export function scan(cfg: Config): Snapshot {
  const ignore = join(cfg.root, ".atexignore");
  const outputs = cfg.outputs.map(o => relative(cfg.root, o)).filter(r => !r.startsWith("..")).map(r => `/${r.split(sep).join("/")}`);
  const list = rules([...DEFAULTS, ...outputs, ...(existsSync(ignore) ? readBounded(ignore, 64 << 10, ".atexignore").split("\n") : []), ...cfg.snapshot.exclude]);
  const allowed = [cfg.root, ...cfg.snapshot.extra.map(e => e.path)].map(p => realpathSync(p));
  const entries: Entry[] = [];
  let bytes = 0;
  const shrink = "exclude large or generated files (.atexignore or [snapshot] exclude), or raise [snapshot] maxBytes/maxFiles";

  const walk = (base: string, dir: string, prefix: string, seen: Set<string>) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, d.name);
      const rel = relative(base, abs).split(sep).join("/");
      let st: Stats | undefined;
      try { st = statSync(abs); } catch { /* broken link, reported below unless excluded */ }
      if (excluded(rel, st?.isDirectory() ?? false, list)) continue;
      if (lstatSync(abs).isSymbolicLink()) {
        if (!st) throw new SnapshotError(`${prefix}${rel} is a broken symlink`, "remove the link or point it at a file in the project");
        const real = realpathSync(abs);
        if (!allowed.some(a => real === a || real.startsWith(a + sep))) {
          throw new SnapshotError(`${prefix}${rel} links outside the project`, "copy the file into the project or add its directory to [snapshot] extra");
        }
      }
      if (!st) throw new SnapshotError(`${prefix}${rel} cannot be read`, "check the file's permissions");
      // A permitted link must not reach a secret: check the canonical target's own path components too.
      const real = realpathSync(abs);
      const home = allowed.find(a => real === a || real.startsWith(a + sep));
      if (!home) throw new SnapshotError(`${prefix}${rel} resolves outside the project`, "copy the file into the project or add its directory to [snapshot] extra");
      if (real !== home && secret(relative(home, real).split(sep).join("/"))) continue;
      if (st.isDirectory()) {
        if (seen.has(real)) throw new SnapshotError(`${prefix}${rel} is a directory link cycle`, "remove the looping link");
        walk(base, abs, prefix, new Set(seen).add(real));
      } else if (st.isFile()) {
        bytes += st.size;
        entries.push({ name: `${prefix}${rel}`, path: real, size: st.size, dev: st.dev, ino: st.ino });
        if (entries.length > cfg.snapshot.maxFiles) throw new SnapshotError(`snapshot has more than ${cfg.snapshot.maxFiles} files`, shrink);
        if (bytes > cfg.snapshot.maxBytes) throw new SnapshotError(`snapshot is over ${cfg.snapshot.maxBytes} bytes`, shrink);
      } else {
        throw new SnapshotError(`${prefix}${rel} is not a regular file or directory`, "remove it or exclude it in .atexignore");
      }
    }
  };
  walk(cfg.root, cfg.root, "src/", new Set([realpathSync(cfg.root)]));
  for (const e of cfg.snapshot.extra) {
    // An extra root is a chosen directory, but it must not itself be (or sit inside) a secret location.
    const real = realpathSync(e.path);
    if (real.split(sep).some(part => part && secret(part))) {
      throw new SnapshotError(`[snapshot] extra ${e.as} lies inside a secret location`, "point extra at a directory outside .git, .env* and key folders");
    }
    walk(e.path, e.path, `ext/${e.as}/`, new Set([real]));
  }
  return { entries, bytes };
}

/** Read exactly the scanned file: no link at the last component, same identity and size, bounded by the scanned size. */
function readEntry(e: Entry): Uint8Array {
  const changed = () => new SnapshotError(`${e.name} changed while it was being sent`, "rerun atex build when the file is no longer being written");
  let fd: number;
  try { fd = openSync(e.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw changed(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== e.dev || st.ino !== e.ino || st.size !== e.size) throw changed();
    const data = Buffer.alloc(e.size);
    for (let off = 0; off < e.size;) {
      const n = readSync(fd, data, off, e.size - off, off);
      if (n === 0) throw changed();
      off += n;
    }
    return data;
  } finally { closeSync(fd); }
}

/**
 * Write the input tar (job first, then the snapshot) through `write`, re-checking each file's size.
 * Returns the tree hash: SHA-256 over sorted `name\0sha256\n` lines.
 */
export async function stream(snap: Snapshot, job: object, write: (chunk: Uint8Array) => Promise<void>): Promise<string> {
  const jobBytes = new TextEncoder().encode(JSON.stringify(job));
  for (const part of [...tarHeader(".atex/job.json", jobBytes.length), jobBytes, padding(jobBytes.length)]) await write(part);
  const lines: string[] = [];
  for (const e of snap.entries) {
    const data = readEntry(e);
    lines.push(`${e.name}\0${await sha256(data)}\n`);
    for (const part of [...tarHeader(e.name, data.length), data, padding(data.length)]) await write(part);
  }
  await write(TAR_END);
  return sha256(new TextEncoder().encode(lines.sort().join("")));
}
