import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { readTar } from "../src/protocol.ts";
import { scan, SnapshotError, stream } from "../src/snapshot.ts";
import { DOC, env, project } from "./helpers.ts";

async function sent(root: string): Promise<{ names: string[]; tree: string }> {
  const cfg = loadConfig({ cwd: root, env: env(root) });
  const parts: Uint8Array[] = [];
  const tree = await stream(scan(cfg), { v: 1 }, async c => { parts.push(c); });
  return { names: [...readTar(Buffer.concat(parts), () => Infinity).keys()], tree };
}

test("AC5: secrets, .git and intermediates never enter the tar stream; .bbl and figures do", async () => {
  const root = project({
    "paper.tex": DOC, "paper.bbl": "b", "fig/plot.pdf": "%PDF", ".env": "TOKEN=x", ".env.local": "x", "keys/id_ed25519": "k", "cert.pem": "c",
    "deep/.npmrc": "t", ".git/config": "g", "paper.aux": "a", "paper.pdf": "%PDF old", "node_modules/x/i.js": "j", ".atexignore": "!.env\n!paper.aux\ndrafts/\n", "drafts/a.tex": "d",
  });
  const { names } = await sent(root);
  expect(names.sort()).toEqual([".atex/job.json", "src/.atexignore", "src/fig/plot.pdf", "src/paper.aux", "src/paper.bbl", "src/paper.tex"]);
});

test("AC9: caps and escaping symlinks fail during the scan, before any container", () => {
  const big = project({ "paper.tex": DOC, "atex.toml": "[snapshot]\nmaxBytes = 100\n", "data.bin": "x".repeat(200) });
  expect(() => scan(loadConfig({ cwd: big, env: env(big) }))).toThrow("over 100 bytes");
  const many = project({ "paper.tex": DOC, "atex.toml": "[snapshot]\nmaxFiles = 2\n", "a.tex": "", "b.tex": "" });
  expect(() => scan(loadConfig({ cwd: many, env: env(many) }))).toThrow("more than 2 files");
  const outside = project({ "secret.txt": "s" });
  const root = project({ "paper.tex": DOC });
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
  expect(() => scan(loadConfig({ cwd: root, env: env(root) }))).toThrow(SnapshotError);
  writeFileSync(join(root, ".atexignore"), "link.txt\n");
  expect(() => scan(loadConfig({ cwd: root, env: env(root) }))).not.toThrow();
});

test("links inside the project are sent as files; extras go under ext/<as>/; the tree hash is stable", async () => {
  const shared = project({ "macros.sty": "\\def\\x{}" });
  const root = project({ "paper.tex": DOC, "atex.toml": `[snapshot]\nextra = [{ path = "${shared}", as = "shared" }]\n` });
  mkdirSync(join(root, "sub"));
  symlinkSync(join(root, "paper.tex"), join(root, "sub", "copy.tex"));
  const a = await sent(root);
  expect(a.names.sort()).toEqual([".atex/job.json", "ext/shared/macros.sty", "src/atex.toml", "src/paper.tex", "src/sub/copy.tex"]);
  expect((await sent(root)).tree).toBe(a.tree);
  writeFileSync(join(root, "paper.tex"), DOC + "%");
  expect((await sent(root)).tree).not.toBe(a.tree);
});
