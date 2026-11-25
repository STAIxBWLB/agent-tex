#!/usr/bin/env python3
"""Build every fixture inside the atex image under the runtime isolation flags.

Usage: python3 image/test-fixtures.py IMAGE [--runtime docker] [--only NAME ...]
Checks AC1 (every fixture builds to a PDF with no network, read-only root, non-root, no capabilities)
and AC2 (LuaLaTeX and XeLaTeX rebuild on a persistent volume without regenerating font caches).
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tarfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
# Lines a font cache rebuild prints: luaotfload's names database, mktexpk/mktextfm, fontconfig.
CACHE_REBUILD = ("generating new one", "please be patient", "mktexpk", "mktextfm", "Fontconfig")
RERUN = ("lualatex", "xelatex-fontspec", "kotex-xelatex")


def snapshot(fixture, edit=""):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tar:
        root = os.path.join(FIXTURES, fixture)
        entries = [(".atex/job.json", os.path.join(root, "job.json"))]
        for dirpath, _, files in sorted(os.walk(root)):
            for file in sorted(files):
                path = os.path.join(dirpath, file)
                rel = os.path.relpath(path, root).replace(os.sep, "/")
                if rel != "job.json":
                    entries.append((f"src/{rel}", path))
        for name, path in entries:  # the protocol puts the job first
            data = open(path, "rb").read()
            if edit and name == f"src/{job_main(root)}":
                data += edit.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def job_main(root):
    return json.load(open(os.path.join(root, "job.json")))["main"]


def run(runtime, image, volume, payload):
    cmd = [runtime, "run", "--rm", "-i", "--network", "none", "--read-only", "--tmpfs", "/tmp",
           "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "1000:1000",
           "--cpus", "2", "--memory", "4g", "--pids-limit", "512",
           "--mount", f"type=volume,src={volume},dst=/work", image, "atex-run"]
    proc = subprocess.run(cmd, input=payload, capture_output=True)
    return proc.returncode, proc.stdout, proc.stderr.decode(errors="replace")


def outputs(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r") as tar:
        names = tar.getnames()
        result = json.loads(tar.extractfile("result.json").read()) if "result.json" in names else None
    return names, result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--runtime", default="docker")
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    fixtures = args.only or sorted(os.listdir(FIXTURES))
    failures = []
    for fixture in fixtures:
        volume = f"atex-fixture-{fixture}-{uuid.uuid4().hex[:8]}"
        try:
            code, out, err = run(args.runtime, args.image, volume, snapshot(fixture))
            names, result = outputs(out) if out else ([], None)
            pdf = f"out/{os.path.splitext(os.path.basename(job_main(os.path.join(FIXTURES, fixture))))[0]}.pdf"
            if code != 0 or pdf not in names or not result or result["status"] != "ok":
                failures.append(fixture)
                print(f"FAIL {fixture}: exit {code}, outputs {names}\n{err[-4000:]}")
                continue
            print(f"ok   {fixture}: {result['outputs'][0]['pages']} page(s), {result['steps'][0]['seconds']}s")
            if fixture in RERUN:
                code, out, err = run(args.runtime, args.image, volume, snapshot(fixture, edit="\n% rebuild\n"))
                hits = [line for line in err.splitlines() if any(k in line for k in CACHE_REBUILD)]
                names, result = outputs(out) if out else ([], None)
                if code != 0 or hits or not result or result["steps"][0]["seconds"] <= 0:
                    failures.append(f"{fixture} (rerun)")
                    print(f"FAIL {fixture} rerun: exit {code}, cache lines {hits}\n{err[-4000:]}")
                else:
                    print(f"ok   {fixture} rerun without font cache rebuild: {result['steps'][0]['seconds']}s")
        finally:
            subprocess.run([args.runtime, "volume", "rm", "-f", volume], capture_output=True)
    if failures:
        print(f"{len(failures)} failed: {', '.join(failures)}")
        return 1
    print(f"all {len(fixtures)} fixtures passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
