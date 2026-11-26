import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readTextBounded } from "./release-fs.ts";
import { isolatedEnv, inspectStaged, type ReleaseManifest } from "./release.ts";

const OUTPUT_BYTES = 2 * 1024 * 1024, PACKAGE_BYTES = 65_536;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`clean install smoke: ${message}; inspect the staged package and rebuild it`);
}
function json(text: string, label: string): ObjectValue {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`clean install smoke: invalid ${label} JSON; rebuild the staged package`); }
  requireValue(object(value), `${label} must be an object`); return value;
}
function contained(root: string, file: string): string {
  const actual = realpathSync(file), rel = relative(root, actual);
  requireValue(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "installed path escapes the private prefix");
  return actual;
}

/** Run one child with bounded output; diagnostics never echo child output. */
export function smokeChild(step: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number; stdout: string }> {
  return new Promise((accept, reject) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let failure: Error | undefined, bytes = 0;
    const output: Buffer[] = [];
    const stop = (message: string) => { failure ??= new Error(`clean install smoke: ${step}: ${message}; inspect the staged package and retry`); proc.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("child timed out"), timeout);
    proc.stdout.on("data", (part: Buffer) => { bytes += part.length; if (bytes > OUTPUT_BYTES) stop("child output exceeded its bound"); else output.push(part); });
    proc.stderr.on("data", (part: Buffer) => { bytes += part.length; if (bytes > OUTPUT_BYTES) stop("child output exceeded its bound"); });
    proc.on("error", () => { failure ??= new Error(`clean install smoke: ${step}: child spawn failed; check npm and Bun are on the isolated PATH`); });
    proc.on("close", code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else accept({ code: code ?? -1, stdout: Buffer.concat(output).toString("utf8") });
    });
  });
}

async function ok(step: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await smokeChild(step, command, args, cwd, env, 30_000);
  requireValue(result.code === 0, `${step} exited ${result.code}`);
  return result.stdout;
}

/** Install only a verified tarball into a private prefix, offline, and exercise read-only commands. */
export async function smokeStagedPackage(dir: string, root = process.cwd()): Promise<ReleaseManifest> {
  const { manifest: metadata, packed } = inspectStaged(dir, root);
  requireValue(object(packed) && (packed.dependencies === undefined || (object(packed.dependencies) && Object.keys(packed.dependencies).length === 0)), "atex ships with no runtime dependencies");
  const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "atex-release-smoke-")));
  try {
    chmodSync(work, 0o700);
    const prefix = join(work, "prefix"), cwd = join(work, "cwd");
    mkdirSync(prefix, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
    const baseEnv = isolatedEnv(work), env = { ...baseEnv, PATH: `${join(prefix, "bin")}${delimiter}${dirname(process.execPath)}${delimiter}${baseEnv.PATH ?? ""}` };
    await ok("install", "npm", ["install", "-g", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, resolve(dir, "package.tgz")], cwd, env);
    const privatePrefix = realpathSync(prefix), packageRoot = contained(privatePrefix, join(prefix, "lib", "node_modules", ...metadata.name.split("/")));
    const installed = json(readTextBounded(contained(privatePrefix, join(packageRoot, "package.json")), PACKAGE_BYTES), "package");
    requireValue(installed.name === metadata.name && installed.version === metadata.version, "installed package identity mismatch");
    const executable = join(prefix, "bin", "atex"); contained(privatePrefix, executable);
    requireValue((await ok("--version", executable, ["--version"], cwd, env)).trim() === metadata.version, "installed CLI version mismatch");
    requireValue((await ok("--help", executable, ["--help"], cwd, env)).includes("atex env check"), "installed CLI help lacks env check");
    // env check reads only: whatever this host has, the answer is a v1 report with exit 0 (ready) or 3.
    const check = await smokeChild("env check", executable, ["env", "check", "--json"], cwd, env, 60_000);
    const report = json(check.stdout, "env check");
    requireValue(report.v === 1 && (check.code === 0) === (report.status === "ready") && [0, 3].includes(check.code)
      && ["ready", "image-missing", "runtime-missing"].includes(String(report.status)), "env check --json broke its contract");
    return metadata;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3) { console.error("usage: bun scripts/release-smoke.ts DIR"); process.exitCode = 1; }
  else {
    try { await smokeStagedPackage(dir); console.log("clean install smoke: ok"); }
    catch (error) { console.error(error instanceof Error ? error.message : "clean install smoke: failed; rebuild the staged package"); process.exitCode = 1; }
  }
}
