import { IMAGE, imageRef, type ImagePin } from "./image.ts";

export type Exec = (argv: string[], options?: { timeoutMs?: number; toStderr?: boolean }) => Promise<{ code: number; stdout: string; stderr: string }>;

export type EnvStatus = "ready" | "runtime-missing" | "image-missing";

export interface EnvReport {
  v: 1;
  status: EnvStatus;
  runtime: { kind: string; cli: string; version: string; arch: string } | null;
  image: { ref: string; digest: string; present: boolean; arch: string | null };
  detail?: string;
  next?: string;
}

// Docker-compatible CLIs in probe order. Apple `container` and SSH executors arrive in P3 (#4).
export const RUNTIMES = ["docker", "podman", "nerdctl"] as const;
const OUTPUT_MAX = 1 << 20;
const PROBE_MS = 20_000;

export const exec: Exec = async (argv, options = {}) => {
  let proc;
  try {
    // toStderr: the child writes progress to our stderr, keeping stdout for the result (and --json).
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: options.toStderr ? 2 : "pipe", stderr: options.toStderr ? "inherit" : "pipe" });
  } catch {
    return { code: 127, stdout: "", stderr: `${argv[0]}: not found` };
  }
  const timer = options.timeoutMs ? setTimeout(() => proc.kill(), options.timeoutMs) : undefined;
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined | null) => {
    if (!(stream instanceof ReadableStream)) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      if (size < OUTPUT_MAX) chunks.push(chunk.subarray(0, OUTPUT_MAX - size));
      size += chunk.length;
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  };
  const [stdout, stderr, code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function field(obj: Record<string, unknown> | null, ...path: string[]): string {
  let value: unknown = obj;
  for (const key of path) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

// Details name a cause class and a local command to run; raw runtime output (socket paths, endpoints) never enters them.
async function findRuntime(run: Exec): Promise<{ runtime: EnvReport["runtime"]; detail: string; next: string }> {
  const seen: string[] = [];
  let next = "install or start a Docker-compatible runtime (docker, podman or nerdctl), then run atex env check";
  for (const cli of RUNTIMES) {
    const res = await run([cli, "info", "--format", "{{json .}}"], { timeoutMs: PROBE_MS });
    if (res.code === 127) continue;
    const info = parseJson(res.stdout.trim());
    // docker and nerdctl report ServerVersion/Architecture; podman reports version.Version/host.arch.
    const version = field(info, "ServerVersion") || field(info, "version", "Version");
    const arch = field(info, "Architecture") || field(info, "host", "arch");
    if (res.code === 0 && version) return { runtime: { kind: cli, cli, version, arch }, detail: "", next: "" };
    seen.push(res.code === 0 ? `${cli} answered with output atex could not read` : `${cli} is installed but its engine did not answer (exit ${res.code})`);
    if (seen.length === 1) next = `start the ${cli} engine; run ${cli} info to see why it fails, then atex env check`;
  }
  return { runtime: null, detail: seen.join("; ") || `none of ${RUNTIMES.join(", ")} is installed`, next };
}

const NO_IMAGE = /no such (image|object)|not found|does not exist|unknown image/i;

export async function envCheck(run: Exec = exec, image: ImagePin = IMAGE): Promise<EnvReport> {
  const ref = imageRef(image);
  const base: EnvReport["image"] = { ref, digest: image.digest, present: false, arch: null };
  const { runtime, detail, next } = await findRuntime(run);
  if (!runtime) return { v: 1, status: "runtime-missing", runtime: null, image: base, detail, next };
  if (!image.digest) {
    return { v: 1, status: "image-missing", runtime, image: base, detail: "this atex build pins no image digest", next: "install an atex release that pins a published image" };
  }
  const res = await run([runtime.cli, "image", "inspect", "--format", "{{json .}}", ref], { timeoutMs: PROBE_MS });
  const info = parseJson(res.stdout.trim().split("\n")[0] ?? "");
  if (res.code === 0 && info) {
    return { v: 1, status: "ready", runtime, image: { ...base, present: true, arch: field(info, "Architecture") || null } };
  }
  if (res.code !== 0 && NO_IMAGE.test(res.stderr)) {
    return { v: 1, status: "image-missing", runtime, image: base, detail: `the pinned image is not present in ${runtime.cli}`, next: "atex env pull" };
  }
  // The engine answered info but cannot inspect images: an environment problem, not a missing image.
  return {
    v: 1, status: "runtime-missing", runtime, image: base,
    detail: res.code === 0 ? `${runtime.cli} image inspect returned output atex could not read` : `${runtime.cli} could not inspect images (exit ${res.code})`,
    next: `run ${runtime.cli} image ls to see why, then atex env check`,
  };
}

export async function envPull(run: Exec = exec, image: ImagePin = IMAGE): Promise<EnvReport> {
  const before = await envCheck(run, image);
  if (before.status !== "image-missing" || !before.runtime || !image.digest) return before;
  // Pull progress goes to stderr; no timeout for a multi-GB pull.
  const res = await run([before.runtime.cli, "pull", imageRef(image)], { toStderr: true });
  const after = await envCheck(run, image);
  if (res.code !== 0 && after.status !== "ready") {
    return {
      ...after,
      detail: `${before.runtime.cli} pull failed (exit ${res.code}); its output above names the cause`,
      next: `check network and registry access with ${before.runtime.cli} pull ${imageRef(image)}, then atex env pull`,
    };
  }
  return after;
}
