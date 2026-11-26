import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build, receipt } from "../src/build.ts";
import { dockerArgv } from "../src/executor/docker.ts";
import type { Runner } from "../src/executor/docker.ts";
import { padding, readOutput, readTar, sha256, tar, TAR_END, tarHeader, type Job } from "../src/protocol.ts";
import { DOC, env, project } from "./helpers.ts";

const enc = new TextEncoder();
const PDF = enc.encode("%PDF-1.5 built");

/** A container stand-in: reads the input tar, then answers with `reply(job)`. */
function fake(reply: (job: Job) => Promise<Uint8Array> | Uint8Array, code = 0): Runner & { calls: number } {
  const run = Object.assign(async (_argv: string[], input: Parameters<Runner>[1]) => {
    run.calls++;
    const parts: Uint8Array[] = [];
    await input(async c => { parts.push(c); });
    const job = JSON.parse(new TextDecoder().decode(readTar(Buffer.concat(parts), () => Infinity).get(".atex/job.json")!)) as Job;
    return { code, stdout: await reply(job) };
  }, { calls: 0 });
  return run;
}

async function ok(job: Job, pdf = PDF): Promise<Uint8Array> {
  const base = job.main.replace(/\.tex$/, "");
  const names = job.variants.length ? job.variants.map(v => `${base}-${v.name}`) : [base];
  const outputs = await Promise.all(names.map(async (n, i) => ({ variant: job.variants[i]?.name ?? "default", path: `out/${n}.pdf`, sha256: await sha256(pdf), pages: 1 })));
  const result = { v: 1, status: "ok", steps: [{ name: "latexmk", exitCode: 0, seconds: 1, upToDate: false }], outputs, omitted: [] };
  return tar([["result.json", enc.encode(JSON.stringify(result))], ...names.map(n => [`out/${n}.pdf`, pdf] as [string, Uint8Array]), [`log/${names[0]}.log`, enc.encode("log")]]);
}

const failed = () => tar([["result.json", enc.encode(JSON.stringify({ v: 1, status: "failed", steps: [{ name: "latexmk", exitCode: 12, seconds: 1, upToDate: false }], outputs: [], omitted: [] }))]]);

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, "latin1");
    }
  };
  walk(dir);
  return out;
}

const io = (run: Runner) => {
  const log = { out: "", err: "" };
  return { log, io: { out: (t: string) => { log.out += t; }, err: (t: string) => { log.err += t; }, run, cli: "docker" } };
};

test("AC1: a successful build adds only the PDF to the project folder; a failed one changes nothing", async () => {
  const root = project({ "paper.tex": DOC, "fig/a.png": "png" });
  const e = env(root);
  const before = listing(root);
  const { io: good } = io(fake(job => ok(job)));
  expect(await build({ cwd: root, env: e }, good)).toBe(0);
  expect(listing(root)).toEqual({ ...before, "paper.pdf": "%PDF-1.5 built" });
  const { io: bad, log } = io(fake(failed, 1));
  const kept = listing(root);
  expect(await build({ cwd: root, env: e }, bad)).toBe(1);
  expect(listing(root)).toEqual(kept);
  expect(log.err).toContain("no PDF was changed");
});

test("AC2: a failing build exits 1 and leaves an existing PDF byte-identical", async () => {
  const root = project({ "paper.tex": DOC, "paper.pdf": "%PDF old bytes" });
  const { io: bad } = io(fake(failed, 1));
  expect(await build({ cwd: root, env: env(root) }, bad)).toBe(1);
  expect(readFileSync(join(root, "paper.pdf"), "latin1")).toBe("%PDF old bytes");
});

test("AC3: --out and out place the PDF elsewhere, also outside the root, and write nothing else there", async () => {
  const root = project({ "paper.tex": DOC, "atex.toml": 'out = "build"\n' });
  const { io: good } = io(fake(job => ok(job)));
  expect(await build({ cwd: root, env: env(root) }, good)).toBe(0);
  expect(readdirSync(join(root, "build"))).toEqual(["paper.pdf"]);
  const away = realpathSync(mkdtempSync(join(tmpdir(), "atex-out-")));
  expect(await build({ cwd: root, out: away, env: env(root) }, good)).toBe(0);
  expect(readdirSync(away)).toEqual(["paper.pdf"]);
  expect(await build({ cwd: root, out: join(away, "final.pdf"), env: env(root) }, good)).toBe(0);
  expect(readdirSync(away).sort()).toEqual(["final.pdf", "paper.pdf"]);
});

test("AC4: malicious output tars are refused with exit 3 and write nothing", async () => {
  const job: Job = { v: 1, main: "paper.tex", engine: "pdflatex", variants: [], dateEpoch: 0, shellEscape: "restricted", latexmkrc: false, fresh: false };
  const good = await ok(job);
  const symlink = Buffer.from(good);
  symlink[156] = "2".charCodeAt(0); // first entry's type byte becomes a symlink; fix the checksum so only the type is wrong
  symlink.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += symlink[i]!;
  symlink.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const huge = Buffer.concat([...tarHeader("out/paper.pdf", 600 << 20), TAR_END]);
  const cases: [string, Uint8Array][] = [
    ["escapes or is not normalized", tar([["out/../../x.pdf", PDF]])],
    ["non-regular entry", symlink],
    ["over its", huge],
    ["not an expected output", tar([["out/other.pdf", PDF]])],
    ["no result.json", tar([["out/paper.pdf", PDF]])],
  ];
  for (const [why, data] of cases) await expect(readOutput(data, job)).rejects.toThrow(why);
  const wrongHash = tar([["result.json", enc.encode(JSON.stringify({ v: 1, status: "ok", steps: [], outputs: [{ variant: "default", path: "out/paper.pdf", sha256: "0".repeat(64), pages: 1 }], omitted: [] }))], ["out/paper.pdf", PDF]]);
  await expect(readOutput(wrongHash, job)).rejects.toThrow("does not match its sha256");
  for (const data of [tar([["out/../../x.pdf", PDF]]), wrongHash]) {
    const root = project({ "paper.tex": DOC });
    const before = listing(root);
    const { io: evil, log } = io(fake(() => data));
    expect(await build({ cwd: root, env: env(root) }, evil)).toBe(3);
    expect(listing(root)).toEqual(before);
    expect(log.err).toContain("rejected the container output");
  }
});

test("AC9 at the CLI level: an over-cap snapshot exits 2 and no container starts", async () => {
  const root = project({ "paper.tex": DOC, "atex.toml": "[snapshot]\nmaxFiles = 1\n" });
  const run = fake(job => ok(job));
  expect(await build({ cwd: root, env: env(root) }, io(run).io)).toBe(2);
  expect(run.calls).toBe(0);
});

test("variants build one PDF each; the job carries them; the receipt id hashes the receipt", async () => {
  const root = project({ "talk.tex": "\\documentclass{beamer}\n", "atex.toml": '[[variants]]\nname = "handout"\nclassOptions = ["handout"]\n[[variants]]\nname = "slides"\n' });
  let seen: Job | undefined;
  const { io: good, log } = io(fake(job => { seen = job; return ok(job); }));
  expect(await build({ cwd: root, env: env(root), json: true }, good)).toBe(0);
  expect(seen?.variants).toEqual([{ name: "handout", classOptions: ["handout"] }, { name: "slides", classOptions: [] }]);
  expect(existsSync(join(root, "talk-handout.pdf")) && existsSync(join(root, "talk-slides.pdf"))).toBe(true);
  const out = JSON.parse(log.out);
  const { id, ...rest } = out.receipt;
  expect(receipt(rest).id).toBe(id);
  expect(JSON.parse(readFileSync(join(env(root).XDG_STATE_HOME, "atex", "projects", readdirSync(join(env(root).XDG_STATE_HOME, "atex", "projects"))[0]!, "last", "receipt.json"), "utf8")).id).toBe(id);
});

test("docker argv: isolation flags, limits, no implicit pull, a per-project volume", () => {
  const argv = dockerArgv("podman", "atex-0123456789abcdef", { cpus: 2, memory: "4g", pids: 512 }, "img@sha256:x");
  for (const flag of ["--rm", "-i", "--read-only", "--network none", "--pull never", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 1000:1000", "--tmpfs /tmp", "--cpus 2", "--memory 4g", "--pids-limit 512"]) {
    expect(argv.join(" ")).toContain(flag);
  }
  expect(argv.slice(-3)).toEqual(["type=volume,src=atex-0123456789abcdef,dst=/work", "img@sha256:x", "atex-run"]);
  expect(argv[0]).toBe("podman");
});

void padding;
void writeFileSync;
