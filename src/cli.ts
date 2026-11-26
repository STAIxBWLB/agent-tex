import { build } from "./build.ts";
import { envCheck, envPull, exec, type EnvReport, type Exec } from "./env.ts";
import type { Runner } from "./executor/docker.ts";
import { IMAGE, type ImagePin } from "./image.ts";
import { version } from "../package.json";

// Exit codes (issue #1): 0 success, 1 document problem, 2 usage or config error, 3 environment problem, 75 deferred.
const USAGE = `atex: container-only LaTeX builds

Usage:
  atex build [MAIN] [--out PATH] [--fresh] [--json]
                            build the PDF in a container; the folder gets only the PDF
  atex env check [--json]   report the container runtime and the pinned image
  atex env pull [--json]    pull the pinned image
  atex --version            print the atex version

Exit codes: 0 ok, 1 document problem, 2 usage or config error, 3 environment problem.`;

// `image` exists so CI can drive the real CLI path against a small pinned image; the CLI itself always uses IMAGE.
// `run` and `cli` let tests drive build without a container runtime.
export interface Io { out: (text: string) => void; err: (text: string) => void; exec: Exec; image?: ImagePin; run?: Runner; cli?: string }

const defaultIo: Io = { out: text => process.stdout.write(text), err: text => process.stderr.write(text), exec };

function render(report: EnvReport): string {
  const rt = report.runtime;
  const lines = [
    `atex env: ${report.status}`,
    `  runtime  ${rt ? `${rt.cli} ${rt.version}${rt.arch ? ` (${rt.arch})` : ""}` : "missing"}`,
    `  image    ${report.image.ref}${report.image.present ? ` present${report.image.arch ? ` (${report.image.arch})` : ""}` : " not present"}`,
  ];
  if (report.detail) lines.push(`  detail   ${report.detail}`);
  if (report.next) lines.push(`  next: ${report.next}`);
  return `${lines.join("\n")}\n`;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const json = argv.includes("--json");
  const args = argv.filter(arg => arg !== "--json");
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (args.length === 1 && args[0] === "--version") {
    io.out(`${version}\n`);
    return 0;
  }
  if (args[0] === "build") return buildCommand(args.slice(1), json, io);
  const [command, sub, ...rest] = args;
  if (command !== "env" || (sub !== "check" && sub !== "pull") || rest.length) {
    io.err(`atex: unknown command or argument: ${args.join(" ")}\n  next: atex --help\n`);
    return 2;
  }
  const image = io.image ?? IMAGE;
  const report = sub === "check" ? await envCheck(io.exec, image) : await envPull(io.exec, image);
  io.out(json ? `${JSON.stringify(report)}\n` : render(report));
  return report.status === "ready" ? 0 : 3;
}

async function buildCommand(args: string[], json: boolean, io: Io): Promise<number> {
  let main: string | undefined;
  let out: string | undefined;
  let fresh = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--fresh") fresh = true;
    else if (arg === "--out" && args[i + 1] !== undefined) out = args[++i];
    else if (!arg.startsWith("-") && main === undefined) main = arg;
    else {
      io.err(`atex build: unknown or incomplete argument: ${arg}\n  next: atex --help\n`);
      return 2;
    }
  }
  return build({ cwd: process.cwd(), main, out, fresh, json }, io);
}
