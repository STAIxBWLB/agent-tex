// atex build (issue #3): config → snapshot → container → validated output → PDFs, state and receipt.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** Write every PDF beside its destination, then rename them all; on any failure the destinations are untouched. */
function place(pdfs: { dest: string; bytes: Uint8Array }[]): void {
  const temps: string[] = [];
  try {
    for (const p of pdfs) {
      mkdirSync(dirname(p.dest), { recursive: true });
      const tmp = join(dirname(p.dest), `.${basename(p.dest)}.atex-${randomUUID().slice(0, 8)}`);
      temps.push(tmp);
      writeFileSync(tmp, p.bytes);
    }
    pdfs.forEach((p, i) => renameSync(temps[i]!, p.dest));
  } finally {
    for (const t of temps) rmSync(t, { force: true });
  }
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
  const image = imageRef(io.image ?? IMAGE);
  const job: Job = {
    v: 1, main: cfg.main, engine: cfg.engine, variants: cfg.variants, dateEpoch: cfg.dateEpoch,
    shellEscape: cfg.shellEscape, latexmkrc: cfg.latexmkrc, fresh: opts.fresh === true,
  };
  let tree = "";
  let res;
  try {
    res = await (io.run ?? runContainer)(dockerArgv(cli, volumeName(cli, cfg.root), cfg.limits, image), async write => { tree = await stream(snap, job, write); });
  } catch (error) {
    if (error instanceof ProtocolError) return fail(io, 3, `rejected the container output: ${error.message}`, "atex env check; report it if the pinned image is in place");
    throw error;
  }
  if (res.inputError instanceof SnapshotError) return fail(io, 2, res.inputError.message, res.inputError.next);
  if (res.code !== 0 && res.code !== 1) {
    if (res.code === 2) return fail(io, 3, "the image refused the build input", "atex env check; the pinned image and this atex release must match");
    if (res.code === 137) return fail(io, 3, "the container was killed (exit 137), usually by the memory limit", "raise [limits] memory in the user config");
  }
  // A stopped engine or a missing image exits without writing a result tar (docker exits 1 or 125).
  if (res.code !== 0 && (res.code !== 1 || res.stdout.length === 0)) {
    return fail(io, 3, `${cli} could not run the build container (exit ${res.code})`, "atex env check, then atex env pull if the image is missing");
  }
  let output: { result: Result; pdfs: Map<string, Uint8Array>; log: string };
  try {
    output = await readOutput(res.stdout, job);
  } catch (error) {
    if (error instanceof ProtocolError) return fail(io, 3, `rejected the container output: ${error.message}`, "atex env check; report it if the pinned image is in place");
    throw error;
  }
  const { result, pdfs, log } = output;

  const last = join(cfg.stateDir, "projects", projectId(cfg.root), "last");
  mkdirSync(last, { recursive: true });
  writeFileSync(join(last, "log"), log);
  writeFileSync(join(last, "result.json"), JSON.stringify(result, null, 2) + "\n");

  if (result.status !== "ok") {
    const step = result.steps.find(s => s.exitCode !== 0);
    if (opts.json) io.out(`${JSON.stringify({ v: 1, status: "failed", steps: result.steps, omitted: result.omitted })}\n`);
    return fail(io, 1, `${step?.name ?? "the build"} failed${step ? ` (exit ${step.exitCode})` : ""}; no PDF was changed`,
      `fix the first error in the output above; the full log is ${join(last, "log")}`);
  }
  const names = cfg.variants.length ? cfg.variants.map(v => `${basename(cfg.main, ".tex")}-${v.name}`) : [basename(cfg.main, ".tex")];
  // readOutput guarantees one listed, hash-checked PDF per jobname when the status is ok.
  const listed = names.map(n => result.outputs.find(o => o.path === `out/${n}.pdf`)!);
  place(names.map((n, i) => ({ dest: cfg.outputs[i]!, bytes: pdfs.get(n)! })));
  const r = receipt({
    v: 1, tool: "atex", sourceTreeSha256: tree, image, engine: cfg.engine, dateEpoch: cfg.dateEpoch,
    outputs: listed.map((o, i) => ({ name: basename(cfg.outputs[i]!), sha256: o.sha256, pages: o.pages })),
  });
  writeFileSync(join(last, "receipt.json"), JSON.stringify(r, null, 2) + "\n");
  if (opts.json) io.out(`${JSON.stringify({ v: 1, status: "ok", receipt: r, outputs: cfg.outputs, steps: result.steps })}\n`);
  else io.out(`${cfg.outputs.map((o, i) => `atex build: ${o} (${r.outputs[i]!.pages ?? "?"} pages)`).join("\n")}\n  receipt ${r.id}\n`);
  return 0;
}
