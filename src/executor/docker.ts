// Docker-compatible executor (issue #3): one container per build, tar in on stdin, tar out on stdout.
import { createHash } from "node:crypto";
import type { Limits } from "../config.ts";
import { OUTPUT_CAPS, ProtocolError } from "../protocol.ts";

/** The cache volume: one per executor and project root. build() holds a per-project lock around its use. */
export function volumeName(cli: string, root: string): string {
  return `atex-${createHash("sha256").update(`${cli}\0${root}`).digest("hex").slice(0, 16)}`;
}

export function dockerArgv(cli: string, volume: string, limits: Limits, image: string): string[] {
  return [
    cli, "run", "--rm", "-i", "--pull", "never", "--network", "none", "--read-only", "--tmpfs", "/tmp",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
    "--cpus", String(limits.cpus), "--memory", limits.memory, "--pids-limit", String(limits.pids),
    "--mount", `type=volume,src=${volume},dst=/work`, image, "atex-run",
  ];
}

export type Writer = (write: (chunk: Uint8Array) => Promise<void>) => Promise<unknown>;
export type Runner = (argv: string[], input: Writer) => Promise<{ code: number; stdout: Uint8Array; inputError?: unknown }>;

/** Run the container: stream the input, pass stderr through, and collect stdout up to the output cap. */
export const runContainer: Runner = async (argv, input) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let inputError: unknown;
  const feed = (async () => {
    try {
      await input(async chunk => { proc.stdin.write(chunk); await proc.stdin.flush(); });
      await proc.stdin.end();
    } catch (error) {
      inputError = error;
      proc.kill();
    }
  })();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of proc.stdout) {
    size += chunk.length;
    if (size > OUTPUT_CAPS.total) { over = true; proc.kill(); break; }
    chunks.push(chunk);
  }
  const code = await proc.exited;
  await feed;
  if (over) throw new ProtocolError(`container output is over ${OUTPUT_CAPS.total} bytes`);
  return { code, stdout: Buffer.concat(chunks), inputError };
};
