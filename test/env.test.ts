import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { envCheck, envPull, type Exec } from "../src/env.ts";

const PINNED = { repo: "registry.example/atex", tag: "2026.1", digest: "sha256:" + "a".repeat(64) };
const DOCKER_INFO = JSON.stringify({ ServerVersion: "27.3.1", Architecture: "aarch64" });

// A fake runtime: maps "cli subcommand" to a result; anything unlisted is "not installed".
function fake(table: Record<string, { code: number; stdout?: string; stderr?: string }>, calls: string[][] = []): Exec {
  return async argv => {
    calls.push(argv);
    const hit = table[`${argv[0]} ${argv[1]}`];
    return hit ? { code: hit.code, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" } : { code: 127, stdout: "", stderr: "not found" };
  };
}

test("no runtime installed is runtime-missing", async () => {
  const report = await envCheck(fake({}), PINNED);
  expect(report.status).toBe("runtime-missing");
  expect(report.detail).toContain("none of docker, podman, nerdctl");
});

test("an installed CLI whose engine is down is runtime-missing and says so", async () => {
  const report = await envCheck(fake({ "docker info": { code: 1, stderr: "Cannot connect to the Docker daemon" } }), PINNED);
  expect(report.status).toBe("runtime-missing");
  expect(report.detail).toContain("Cannot connect");
});

test("runtime present without the pinned image is image-missing", async () => {
  const report = await envCheck(fake({ "docker info": { code: 0, stdout: DOCKER_INFO }, "docker image": { code: 1, stderr: "No such image" } }), PINNED);
  expect(report.status).toBe("image-missing");
  expect(report.runtime).toEqual({ kind: "docker", cli: "docker", version: "27.3.1", arch: "aarch64" });
  expect(report.next).toBe("atex env pull");
});

test("podman info shape is understood", async () => {
  const info = JSON.stringify({ version: { Version: "5.2.0" }, host: { arch: "amd64" } });
  const report = await envCheck(fake({ "podman info": { code: 0, stdout: info }, "podman image": { code: 0, stdout: JSON.stringify({ Architecture: "amd64" }) } }), PINNED);
  expect(report.status).toBe("ready");
  expect(report.runtime?.version).toBe("5.2.0");
  expect(report.image).toEqual({ ref: `${PINNED.repo}@${PINNED.digest}`, digest: PINNED.digest, present: true, arch: "amd64" });
});

test("a build with no pinned digest is image-missing without touching the runtime image store", async () => {
  const calls: string[][] = [];
  const report = await envCheck(fake({ "docker info": { code: 0, stdout: DOCKER_INFO } }, calls), { ...PINNED, digest: "" });
  expect(report.status).toBe("image-missing");
  expect(report.image.ref).toBe("registry.example/atex:2026.1");
  expect(calls.some(argv => argv[1] === "image")).toBe(false);
});

test("env pull pulls the pinned digest and re-checks", async () => {
  const calls: string[][] = [];
  let pulled = false;
  const run: Exec = async (argv, options) => {
    calls.push(argv);
    if (argv[1] === "info") return { code: 0, stdout: DOCKER_INFO, stderr: "" };
    if (argv[1] === "pull") { pulled = true; expect(options?.toStderr).toBe(true); return { code: 0, stdout: "", stderr: "" }; }
    return pulled ? { code: 0, stdout: JSON.stringify({ Architecture: "arm64" }), stderr: "" } : { code: 1, stdout: "", stderr: "No such image" };
  };
  const report = await envPull(run, PINNED);
  expect(report.status).toBe("ready");
  expect(calls).toContainEqual(["docker", "pull", `${PINNED.repo}@${PINNED.digest}`]);
});

test("cli: env check --json exits 3 when the runtime is missing, usage errors exit 2", async () => {
  let out = "";
  let err = "";
  const io = { out: (t: string) => { out += t; }, err: (t: string) => { err += t; }, exec: fake({}) };
  expect(await main(["env", "check", "--json"], io)).toBe(3);
  expect(JSON.parse(out).status).toBe("runtime-missing");
  expect(await main(["build"], io)).toBe(2);
  expect(err).toContain("next: atex --help");
  expect(await main(["--help"], io)).toBe(0);
});
