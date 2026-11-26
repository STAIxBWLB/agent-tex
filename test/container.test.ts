// Container tests for P2 (issue #3): opt-in, they run only with ATEX_TEST_IMAGE (CI sets atex:test after building it).
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { build } from "../src/build.ts";
import { env, project } from "./helpers.ts";

const IMAGE = process.env.ATEX_TEST_IMAGE;
const CLI = process.env.ATEX_TEST_CLI ?? "docker";
const LONG = 600_000;
const FIXTURES = join(import.meta.dir, "..", "image", "fixtures");

function fixture(name: string, extra: Record<string, string> = {}): string {
  const root = project(extra);
  cpSync(join(FIXTURES, name), root, { recursive: true });
  rmSync(join(root, "job.json"));
  return root;
}

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

async function atex(root: string, opts: { out?: string; fresh?: boolean } = {}) {
  const [repo, tag] = IMAGE!.split(":");
  let out = "";
  let err = "";
  const code = await build({ cwd: root, env: env(root), json: true, ...opts }, {
    out: t => { out += t; }, err: t => { err += t; }, cli: CLI, image: { repo: repo!, tag: tag ?? "latest", digest: "" },
  });
  return { code, json: out ? JSON.parse(out) : null, err };
}

describe.skipIf(!IMAGE)("atex build in the container", () => {
  test("AC1/AC2: success adds only the PDF; failure exits 1 and changes nothing", async () => {
    const root = fixture("pdflatex-bibtex");
    const before = listing(root);
    const ok = await atex(root);
    expect(ok.code).toBe(0);
    const after = listing(root);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "paper.pdf"].sort());
    for (const [name, text] of Object.entries(before)) expect(after[name]).toBe(text);
    writeFileSync(join(root, "paper.tex"), readFileSync(join(root, "paper.tex"), "utf8").replace("\\end{document}", "\\undefinedcommand\n\\end{document}"));
    const kept = listing(root);
    const bad = await atex(root);
    expect(bad.code).toBe(1);
    expect(listing(root)).toEqual(kept);
  }, LONG);

  test("AC3: --out outside the root receives only the PDF", async () => {
    const root = fixture("lualatex");
    const away = realpathSync(mkdtempSync(join(tmpdir(), "atex-away-")));
    const before = listing(root);
    expect((await atex(root, { out: away })).code).toBe(0);
    expect(readdirSync(away)).toEqual(["paper.pdf"]);
    expect(listing(root)).toEqual(before);
  }, LONG);

  test("AC6/AC7: an unchanged rebuild is up to date; --fresh reruns and gives the same PDF bytes", async () => {
    const root = fixture("pdflatex-bibtex", { "atex.toml": 'date = "2026-01-01"\n' });
    const first = await atex(root);
    expect(first.code).toBe(0);
    const again = await atex(root);
    expect(again.json.steps[0].upToDate).toBe(true);
    const fresh = await atex(root, { fresh: true });
    expect(fresh.json.steps[0].upToDate).toBe(false);
    expect(fresh.json.receipt.outputs[0].sha256).toBe(first.json.receipt.outputs[0].sha256);
    expect(fresh.json.receipt.id).toBe(first.json.receipt.id);
  }, LONG);

  test("T5: XeLaTeX and LuaLaTeX reproducibility across a --fresh rebuild (measured for the README, not asserted)", async () => {
    for (const name of ["xelatex-fontspec", "lualatex"]) {
      const root = fixture(name, { "atex.toml": 'date = "2026-01-01"\n' });
      const a = await atex(root);
      const b = await atex(root, { fresh: true });
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      console.log(`T5: ${name} identical=${a.json.receipt.outputs[0].sha256 === b.json.receipt.outputs[0].sha256}`);
    }
  }, LONG);

  test("AC8: the build has no network, even with unrestricted shell escape", async () => {
    const probe = "import urllib.request\nopen('ran', 'w').close()\nurllib.request.urlopen('http://example.com', timeout=10)\nopen('net-ok', 'w').close()\n";
    const root = project({
      "atex.toml": 'shellEscape = "unrestricted"\n',
      "probe.py": probe,
      "paper.tex": "\\documentclass{article}\n\\immediate\\write18{python3 probe.py}\n\\IfFileExists{ran}{}{\\errmessage{shell escape did not run}}\n\\IfFileExists{net-ok}{\\errmessage{network reachable}}{}\n\\begin{document}offline\\end{document}\n",
    });
    const res = await atex(root);
    expect(res.err).not.toContain("network reachable");
    expect(res.code).toBe(0);
  }, LONG);

  test("variants: class options reach the class (beamer handout collapses overlays)", async () => {
    const root = project({
      "talk.tex": "\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}A\\only<2>{B}\\end{frame}\n\\end{document}\n",
      "atex.toml": '[[variants]]\nname = "slides"\n[[variants]]\nname = "handout"\nclassOptions = ["handout"]\n',
    });
    const res = await atex(root);
    expect(res.code).toBe(0);
    expect(res.json.receipt.outputs.map((o: { name: string; pages: number }) => [o.name, o.pages])).toEqual([["talk-slides.pdf", 2], ["talk-handout.pdf", 1]]);
  }, LONG);

  test("T6: overhead of a 100 MiB snapshot (printed for the PR)", async () => {
    const root = fixture("pdflatex-bibtex", { "atex.toml": "[snapshot]\nmaxBytes = 209715200\n" });
    expect((await atex(root)).code).toBe(0);
    let t = performance.now();
    expect((await atex(root)).code).toBe(0);
    const small = performance.now() - t;
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `blob${i}.bin`), randomBytes(10 << 20));
    t = performance.now();
    expect((await atex(root)).code).toBe(0);
    const big = performance.now() - t;
    console.log(`T6: up-to-date rebuild ${(small / 1000).toFixed(1)} s; with 100 MiB more in the snapshot ${(big / 1000).toFixed(1)} s`);
  }, LONG);
});
