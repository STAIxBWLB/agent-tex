import { envCheck, envPull, exec, type EnvReport, type Exec } from "./env.ts";

// Exit codes (issue #1): 0 success, 1 document problem, 2 usage or config error, 3 environment problem, 75 deferred.
const USAGE = `atex: container-only LaTeX builds

Usage:
  atex env check [--json]   report the container runtime and the pinned image
  atex env pull [--json]    pull the pinned image

Exit codes: 0 ready, 2 usage error, 3 runtime or image missing.`;

export interface Io { out: (text: string) => void; err: (text: string) => void; exec: Exec }

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
  const [command, sub, ...rest] = args;
  if (command !== "env" || (sub !== "check" && sub !== "pull") || rest.length) {
    io.err(`atex: unknown command or argument: ${args.join(" ")}\n  next: atex --help\n`);
    return 2;
  }
  const report = sub === "check" ? await envCheck(io.exec) : await envPull(io.exec);
  io.out(json ? `${JSON.stringify(report)}\n` : render(report));
  return report.status === "ready" ? 0 : 3;
}
