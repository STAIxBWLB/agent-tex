import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPackageFiles, distTagFor, inspectStaged, releaseSection } from "../scripts/release.ts";
import { main } from "../src/cli.ts";
import pkg from "../package.json";

const FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "bin/atex.js", "src/cli.ts", "src/index.ts"];

test("dist-tag follows the prerelease marker", () => {
  expect(distTagFor("0.1.0")).toBe("latest");
  expect(distTagFor("0.2.0-rc.1")).toBe("next");
  expect(() => distTagFor("v0.1")).toThrow("semantic version");
});

test("a release needs exactly one dated changelog section", () => {
  const text = "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-11-27\n\n- first\n\n## [0.0.1] - 2026-11-01\n\n- old\n";
  expect(releaseSection(text, "0.1.0")).toBe("- first");
  expect(() => releaseSection("## Unreleased\n\n- x\n", "0.1.0")).toThrow("dated section");
  expect(() => releaseSection("## [0.1.0] - 2026-02-30\n\n- x\n", "0.1.0")).toThrow("valid YYYY-MM-DD");
});

test("the packed file list is limited to src, bin and the four documents", () => {
  expect(() => assertPackageFiles(FILES)).not.toThrow();
  expect(() => assertPackageFiles([...FILES, "test/env.test.ts"])).toThrow("unexpected packed path");
  expect(() => assertPackageFiles(FILES.filter(f => f !== "bin/atex.js"))).toThrow("missing bin/atex.js");
  expect(() => assertPackageFiles([...FILES, "src/../x.ts"])).toThrow("unsafe archive member path");
});

test("atex --version prints the package version", async () => {
  let out = "";
  const io = { out: (t: string) => { out += t; }, err: () => {}, exec: async () => ({ code: 127, stdout: "", stderr: "" }) };
  expect(await main(["--version"], io)).toBe(0);
  expect(out.trim()).toBe(pkg.version);
});

test("a missing staged tarball names the local read, not git or GitHub credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "atex-release-test-"));
  expect(() => inspectStaged(dir)).toThrow("release artifact read: local file problem; check that the stage directory holds a readable regular package.tgz");
});
