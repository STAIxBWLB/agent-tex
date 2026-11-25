#!/usr/bin/env python3
"""atex-run: the only entry point of the atex image.

Stream protocol v1, P1 subset (full protocol: issue #3).
stdin:  tar with `.atex/job.json` ({v: 1, main, engine, dateEpoch, shellEscape}) and sources under `src/`.
stdout: tar with `result.json`, `out/<name>.pdf` (only on success), `log/<name>.log`, `deps/<name>.fls`.
stderr: progress (latexmk output).
Exit: 0 built, 1 document failure (tar still written), 2 bad job or input tar (no tar written).
"""
import hashlib
import io
import json
import os
import posixpath
import subprocess
import sys
import tarfile
import time

WORK = os.environ.get("ATEX_WORK", "/work")
SRC = os.path.join(WORK, "src")
ENGINES = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}
JOB_MAX = 1 << 20


def fail(message):
    sys.stderr.write(f"atex-run: {message}\n")
    sys.exit(2)


def safe_rel(name):
    """Return a normalized relative path under src/, or None for the job entry; reject anything else."""
    if name.startswith("/") or "\\" in name:
        fail(f"input tar entry {name!r} is absolute or uses backslashes")
    norm = posixpath.normpath(name)
    if norm == ".atex/job.json":
        return None
    if norm == "src":
        return ""
    if not norm.startswith("src/") or ".." in norm.split("/"):
        fail(f"input tar entry {name!r} is outside src/")
    return norm[4:]


def read_input():
    job = None
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
        for member in tar:
            rel = safe_rel(member.name)
            if rel is None:
                if not member.isfile() or member.size > JOB_MAX:
                    fail(".atex/job.json must be a regular file under 1 MiB")
                job = json.loads(tar.extractfile(member).read())
                continue
            target = os.path.join(SRC, rel)
            if member.isdir():
                os.makedirs(target, exist_ok=True)
            elif member.isfile():
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as out:
                    src = tar.extractfile(member)
                    while chunk := src.read(1 << 16):
                        out.write(chunk)
            else:
                fail(f"input tar entry {member.name!r} is not a regular file or directory")
    if not isinstance(job, dict) or job.get("v") != 1:
        fail("input tar has no .atex/job.json with v: 1")
    main = job.get("main")
    if not isinstance(main, str) or not main.endswith(".tex") or main.startswith("/") or ".." in main.split("/"):
        fail("job.main must be a relative .tex path inside the project")
    if not os.path.isfile(os.path.join(SRC, main)):
        fail(f"job.main {main!r} is not in the snapshot")
    if job.get("engine", "pdflatex") not in ENGINES:
        fail(f"job.engine must be one of {', '.join(ENGINES)}")
    if job.get("shellEscape", "restricted") not in ("restricted", "unrestricted"):
        fail("job.shellEscape must be restricted or unrestricted")
    epoch = job.get("dateEpoch", 0)
    if not isinstance(epoch, int) or epoch < 0:
        fail("job.dateEpoch must be a non-negative integer")
    return job


def environment(job):
    env = dict(os.environ)
    home = os.path.join(WORK, "home")
    env.update(
        HOME=home,
        TEXMFVAR=os.path.join(WORK, "texmf-var"),
        XDG_CACHE_HOME=os.path.join(WORK, "cache"),
        max_print_line="10000",  # no log wrapping; bibtex refuses values at or above its buf_size (20000)
        error_line="254",
        half_error_line="238",
        SOURCE_DATE_EPOCH=str(job.get("dateEpoch", 0)),
        FORCE_SOURCE_DATE="1",
        # biber is a PAR-packed binary that unpacks and execs from its temp dir; /tmp is noexec.
        PAR_GLOBAL_TMPDIR=os.path.join(WORK, "cache", "par"),
    )
    for path in (home, env["TEXMFVAR"], env["XDG_CACHE_HOME"], env["PAR_GLOBAL_TMPDIR"]):
        os.makedirs(path, exist_ok=True)
    return env


def pages(pdf):
    try:
        info = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    for line in info.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return None


def add(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def main():
    job = read_input()
    main_tex = job["main"]
    engine = job.get("engine", "pdflatex")
    cwd = os.path.join(SRC, posixpath.dirname(main_tex))
    name = posixpath.basename(main_tex)[: -len(".tex")]
    cmd = ["latexmk", ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-recorder"]
    if job.get("shellEscape") == "unrestricted":
        cmd.append("-shell-escape")
    cmd.append(posixpath.basename(main_tex))
    started = time.monotonic()
    # latexmk's stdout goes to stderr: stdout carries only the result tar.
    code = subprocess.run(cmd, cwd=cwd, env=environment(job), stdin=subprocess.DEVNULL, stdout=sys.stderr.fileno()).returncode
    seconds = round(time.monotonic() - started, 3)
    pdf = os.path.join(cwd, f"{name}.pdf")
    ok = code == 0 and os.path.isfile(pdf)
    result = {"v": 1, "status": "ok" if ok else "failed", "steps": [{"name": "latexmk", "exitCode": code, "seconds": seconds}], "outputs": []}
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        if ok:
            data = open(pdf, "rb").read()
            result["outputs"].append({"variant": "default", "path": f"out/{name}.pdf", "sha256": hashlib.sha256(data).hexdigest(), "pages": pages(pdf)})
            add(tar, f"out/{name}.pdf", data)
        for ext, folder in (("log", "log"), ("fls", "deps")):
            path = os.path.join(cwd, f"{name}.{ext}")
            if os.path.isfile(path):
                add(tar, f"{folder}/{name}.{ext}", open(path, "rb").read())
        add(tar, "result.json", json.dumps(result, separators=(",", ":")).encode())
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
