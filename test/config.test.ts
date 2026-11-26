import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConfigError, detectEngine, documentClass, loadConfig } from "../src/config.ts";
import { DOC, env, project } from "./helpers.ts";

test("engine: magic comment, then fontspec/xeCJK, then directlua, else pdflatex", () => {
  expect(detectEngine("% !TEX program = lualatex\n\\usepackage{fontspec}")).toBe("lualatex");
  expect(detectEngine("\\documentclass{article}\n\\usepackage[no-math]{fontspec}\n\\begin{document}")).toBe("xelatex");
  expect(detectEngine("\\usepackage{xeCJK}")).toBe("xelatex");
  expect(detectEngine("\\directlua{tex.print(1)}")).toBe("lualatex");
  expect(detectEngine("% \\usepackage{fontspec}\n\\usepackage{kotex}")).toBe("pdflatex");
  expect(detectEngine("\\begin{document}\\usepackage{fontspec}")).toBe("pdflatex");
  expect(documentClass("\\documentclass[11pt]{beamer}")).toBe("beamer");
});

test("main detection: the only root .tex with \\documentclass, else exit-2 errors listing candidates", () => {
  const one = project({ "paper.tex": DOC, "chapter.tex": "\\section{A}" });
  expect(loadConfig({ cwd: one, env: env(one) }).main).toBe("paper.tex");
  const two = project({ "a.tex": DOC, "b.tex": DOC });
  expect(() => loadConfig({ cwd: two, env: env(two) })).toThrow("several main files: a.tex, b.tex");
  const none = project({ "notes.txt": "x" });
  expect(() => loadConfig({ cwd: none, env: env(none) })).toThrow(ConfigError);
});

test("atex.toml: root search, unknown keys, variants, outputs and the default date", () => {
  const root = project({ "atex.toml": 'main = "src/talk.tex"\n[[variants]]\nname = "handout"\nclassOptions = ["handout"]\n[[variants]]\nname = "slides"\n', "src/talk.tex": "\\documentclass{beamer}\n" });
  const cfg = loadConfig({ cwd: join(root, "src"), env: env(root), now: Date.parse("2026-11-27T15:00:00Z") });
  expect(cfg.root).toBe(root);
  expect(cfg.outputs).toEqual([join(root, "src", "talk-handout.pdf"), join(root, "src", "talk-slides.pdf")]);
  expect(cfg.dateEpoch).toBe(Date.parse("2026-11-27T00:00:00Z") / 1000);
  expect(loadConfig({ cwd: root, out: "/tmp/x", env: env(root) }).outputs[0]).toBe("/tmp/x/talk-handout.pdf");
  expect(() => loadConfig({ cwd: root, out: "one.pdf", env: env(root) })).toThrow("several variants");
  const bad = project({ "atex.toml": 'mian = "x.tex"\n', "x.tex": DOC });
  expect(() => loadConfig({ cwd: bad, env: env(bad) })).toThrow("unknown key mian");
  const escape = project({ "atex.toml": 'main = "../x.tex"\n' });
  expect(() => loadConfig({ cwd: escape, env: env(escape) })).toThrow("inside the project");
});
