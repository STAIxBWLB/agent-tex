// atex build (issue #3): config → snapshot → container → validated output → PDFs, state and receipt.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { dockerArgv, runContainer, volumeName, type Runner } from "./executor/docker.ts";
import { RUNTIMES } from "./env.ts";
import { imageRef, IMAGE, type ImagePin } from "./image.ts";
import { ProtocolError, readOutput, type Job, type Result } from "./protocol.ts";
import { scan, SnapshotError, stream } from "./snapshot.ts";

export interface BuildOptions { cwd: string; main?: string; out?: string; fresh?: boolean; json?: boolean; env?: Record<string, string | undefined>; now?: number }
export interface BuildIo { out: (text: string) => void; err: (text: string) => void; image?: ImagePin; run?: Runner; cli?: string }

export interface Receipt {
  v: 1; tool: "atex"; id: string; sourceTreeSha256: string; image: string; engine: string; dateEpoch: number;
  outputs: { name: string; sha256: string; pages: number | null }[];
}

export function receipt(fields: Omit<Receipt, "id">): Receipt {
  const { v, tool, sourceTreeSha256, image, engine, dateEpoch, outputs } = fields;
  const body = { v, tool, sourceTreeSha256, image, engine, dateEpoch, outputs };
  const id = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { v, tool, id, sourceTreeSha256, image, engine, dateEpoch, outputs };
}

const projectId = (root: string) => createHash("sha256").update(root).digest("hex").slice(0, 16);

/** The first Docker-compatible CLI on PATH; `atex env check` explains a missing or stopped engine. */
function findCli(): string | null {
  return RUNTIMES.find(cli => Bun.which(cli)) ?? null;
}

class OutputError extends Error {
  constructor(message: string, readonly next: string) { super(message); }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code ?? "unknown error";

interface Commit { rollback: () => string[]; finish: () => void }

/**
 * Stage every PDF beside its destination, then swap them in, keeping each original aside. The caller finishes the
 * commit once the receipt is written, or rolls it back; rollback returns the paths it could not restore.
 */
function place(pdfs: { dest: string; bytes: Uint8Array }[], io: BuildIo): Commit {
  for (const p of pdfs) {
    if (existsSync(p.dest) && !lstatSync(p.dest).isFile()) throw new OutputError(`${p.dest} exists and is not a regular file`, "remove it or choose another --out");
  }
  const tag = randomUUID();
  const temp = (dest: string, kind: string) => join(dirname(dest), `.${basename(dest)}.atex-${kind}-${tag}`);
  const staged: string[] = [];
  const done: { dest: string; backup: string | null }[] = [];
  const rollback = () => {
    const lost: string[] = [];
    for (const d of done.reverse()) {
      try { if (d.backup) renameSync(d.backup, d.dest); else rmSync(d.dest, { force: true }); }
      catch { lost.push(d.backup ? `${d.dest} (its previous version is ${d.backup})` : d.dest); }
    }
    done.length = 0;
    return lost;
  };
  const cleanup = () => { for (const t of staged) removeTemporary(t, io); };
  try {
    for (const p of pdfs) {
      try {
        mkdirSync(dirname(p.dest), { recursive: true });
        staged.push(temp(p.dest, "new"));
        writeFileSync(staged.at(-1)!, p.bytes, { flag: "wx" });
      } catch (error) {
        throw new OutputError(`could not write beside ${p.dest} (${errno(error)})`, `check that ${dirname(p.dest)} is writable and has space`);
      }
    }
    pdfs.forEach((p, i) => {
      try {
        const backup = existsSync(p.dest) ? temp(p.dest, "old") : null;
        if (backup) renameSync(p.dest, backup);
        done.push({ dest: p.dest, backup });
        renameSync(staged[i]!, p.dest);
      } catch (error) {
        throw new OutputError(restored(`could not replace ${p.dest} (${errno(error)})`, rollback()), `check that ${dirname(p.dest)} is writable`);
      }
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
  return { rollback, finish: () => { for (const d of done) if (d.backup) removeTemporary(d.backup, io); } };
}

/** Describe a rollback truthfully: everything restored, or which paths were not. */
function restored(cause: string, lost: string[]): string {
  return lost.length ? `${cause}; could not restore ${lost.join(", ")}` : `${cause}; the previous PDFs were restored`;
}

/**
 * One build per project at a time: the cache volume holds one mutable source tree. Returns a release, or the
 * holder's pid when busy. A lock left by a build that died is not taken over automatically (no safe primitive for
 * that here); the message names the file to remove.
 */
function lock(file: string): { release: () => void } | { holder: string; file: string } {
  try {
    writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    return { release: () => rmSync(file, { force: true }) };
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  let holder = "unknown";
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fstatSync(fd).isFile()) {
        const buf = Buffer.alloc(16);
        const text = buf.subarray(0, readSync(fd, buf, 0, 16, 0)).toString("utf8");
        if (/^[1-9][0-9]{0,9}$/.test(text) && Number(text) <= 0x7fffffff) holder = text;
      }
    } finally { closeSync(fd); }
  } catch { /* unreadable lock record: report it as unknown */ }
  return { holder, file };
}

function alive(pid: string): boolean {
  try { process.kill(Number(pid), 0); return true; } catch (error) { return errno(error) === "EPERM"; }
}

function removeTemporary(file: string, io: BuildIo): void {
  try { rmSync(file, { force: true }); }
  catch (error) { io.err(`atex build: could not remove temporary file ${file} (${errno(error)})\n  next: remove it after checking permissions\n`); }
}

function fail(io: BuildIo, code: number, message: string, next: string): number {
  io.err(`atex build: ${message}\n  next: ${next}\n`);
  return code;
}

export async function build(opts: BuildOptions, io: BuildIo): Promise<number> {
  let cfg: Config;
  let snap;
  try {
    cfg = loadConfig(opts);
    snap = scan(cfg);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof SnapshotError) return fail(io, 2, error.message, error.next);
    throw error;
  }
  const cli = io.cli ?? findCli();
  if (!cli) return fail(io, 3, `none of ${RUNTIMES.join(", ")} is installed`, "atex env check");
  const dir = join(cfg.stateDir, "projects", projectId(cfg.root));
  let held;
  try { held = lock(join("/tmp", `atex-build-${process.getuid?.() ?? 0}-${projectId(realpathSync(cfg.root))}.lock`)); }
  catch (error) { return fail(io, 3, `could not acquire the build lock (${errno(error)})`, "check that /tmp is writable and the project directory still exists"); }
  if ("holder" in held) {
    return held.holder !== "unknown" && alive(held.holder)
      ? fail(io, 75, `another atex build of this project is running (pid ${held.holder})`, "wait for it to finish, then rerun atex build")
      : fail(io, 75, `a previous atex build of this project did not finish (lock ${held.file}, pid ${held.holder})`, `if no atex build is running, remove ${held.file} and rerun`);
  }
  try {
    return await run(cfg, snap, cli, dir, opts, io);
  } finally {
    try { held.release(); }
    catch (error) { io.err(`atex build: could not release the project lock (${errno(error)})\n  next: retry after checking /tmp permissions and the lock status\n`); }
  }
}

async function run(cfg: Config, snap: ReturnType<typeof scan>, cli: string, dir: string, opts: BuildOptions, io: BuildIo): Promise<number> {
  const image = imageRef(io.image ?? IMAGE);
  const job: Job = {
    v: 1, main: cfg.main, engine: cfg.engine, variants: cfg.variants, dateEpoch: cfg.dateEpoch,
    shellEscape: cfg.shellEscape, latexmkrc: cfg.latexmkrc, fresh: opts.fresh === true,
  };
  const rejected = (error: ProtocolError) => fail(io, 3, `rejected the container output: ${error.message}`, "atex env check; report it if the pinned image is in place");
  let tree = "";
  let res;
  try {
    res = await (io.run ?? runContainer)(dockerArgv(cli, volumeName(cli, cfg.root), cfg.limits, image), async write => { tree = await stream(snap, job, write); });
  } catch (error) {
    if (error instanceof ProtocolError) return rejected(error);
    throw error;
  }
  if (res.inputError instanceof SnapshotError) return fail(io, 2, res.inputError.message, res.inputError.next);
  if (res.code === 2) return fail(io, 3, "the image refused the build input", "atex env check; the pinned image and this atex release must match");
  if (res.code === 137) return fail(io, 3, "the container was killed (exit 137), usually by the memory limit", "raise [limits] memory in the user config");
  // A stopped engine or a missing image exits without writing a result tar (docker exits 1 or 125).
  if (res.code !== 0 && (res.code !== 1 || res.stdout.length === 0)) {
    return fail(io, 3, `${cli} could not run the build container (exit ${res.code})`, "atex env check, then atex env pull if the image is missing");
  }
  let output: { result: Result; pdfs: Map<string, Uint8Array>; log: string };
  try {
    output = await readOutput(res.stdout, job);
  } catch (error) {
    if (error instanceof ProtocolError) return rejected(error);
    throw error;
  }
  const { result, pdfs, log } = output;
  if ((res.code === 0) !== (result.status === "ok")) return rejected(new ProtocolError(`exit status ${res.code} disagrees with result.json status ${result.status}`));

  const last = join(dir, "last");
  const stateFailed = (error: unknown) => fail(io, 3, `could not write the build state (${errno(error)})`, `check that ${cfg.stateDir} is writable, or set XDG_STATE_HOME`);
  try {
    mkdirSync(last, { recursive: true });
    writeFileSync(join(last, "log"), log);
    writeFileSync(join(last, "result.json"), JSON.stringify(result, null, 2) + "\n");
  } catch (error) { return stateFailed(error); }

  if (result.status !== "ok") {
    const step = result.steps.find(s => s.exitCode !== 0);
    if (opts.json) io.out(`${JSON.stringify({ v: 1, status: "failed", steps: result.steps, omitted: result.omitted })}\n`);
    return fail(io, 1, `${step?.name ?? "the build"} failed${step ? ` (exit ${step.exitCode})` : " (an output was over its cap)"}; no PDF was changed`,
      `fix the first error in the output above; the full log is ${join(last, "log")}`);
  }
  const names = cfg.variants.length ? cfg.variants.map(v => `${basename(cfg.main, ".tex")}-${v.name}`) : [basename(cfg.main, ".tex")];
  // readOutput guarantees one listed, hash-checked PDF per jobname when the status is ok.
  const listed = names.map(n => result.outputs.find(o => o.path === `out/${n}.pdf`)!);
  let commit: Commit;
  try {
    commit = place(names.map((n, i) => ({ dest: cfg.outputs[i]!, bytes: pdfs.get(n)! })), io);
  } catch (error) {
    if (error instanceof OutputError) return fail(io, 3, error.message, error.next);
    return fail(io, 3, `could not prepare the PDF destinations (${errno(error)})`, "check the output paths and their permissions, or choose another --out");
  }
  const r = receipt({
    v: 1, tool: "atex", sourceTreeSha256: tree, image, engine: cfg.engine, dateEpoch: cfg.dateEpoch,
    outputs: listed.map((o, i) => ({ name: basename(cfg.outputs[i]!), sha256: o.sha256, pages: o.pages })),
  });
  // The PDFs and the receipt are published together: a receipt that cannot be written undoes the PDFs.
  const stagedReceipt = join(last, `.receipt-${randomUUID()}.tmp`);
  try {
    writeFileSync(stagedReceipt, JSON.stringify(r, null, 2) + "\n", { flag: "wx" });
    renameSync(stagedReceipt, join(last, "receipt.json"));
  } catch (error) {
    removeTemporary(stagedReceipt, io);
    return fail(io, 3, restored(`could not write the receipt (${errno(error)})`, commit.rollback()), `check that ${cfg.stateDir} is writable, or set XDG_STATE_HOME`);
  }
  commit.finish();
  if (opts.json) io.out(`${JSON.stringify({ v: 1, status: "ok", receipt: r, outputs: cfg.outputs, steps: result.steps })}\n`);
  else io.out(`${cfg.outputs.map((o, i) => `atex build: ${o} (${r.outputs[i]!.pages ?? "?"} pages)`).join("\n")}\n  receipt ${r.id}\n`);
  return 0;
}
