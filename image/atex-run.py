#!/usr/bin/env python3
"""atex-run: the only entry point of the atex image.

Stream protocol v1, P1 subset (full protocol: issue #3).
stdin:  tar with `.atex/job.json` ({v: 1, main, engine, dateEpoch, shellEscape}) and sources under `src/`.
stdout: tar with `result.json`, `out/<name>.pdf` (only on success), `log/<name>.log`, `deps/<name>.fls`.
stderr: progress (latexmk output).
Exit: 0 built, 1 document failure (tar still written), 2 bad job or input tar (no tar written; stderr names the cause and next step).
Caps: input entries and bytes, and each output artifact (oversize artifacts are omitted and listed in result.json).
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
JOB_KEYS = {"v", "main", "engine", "dateEpoch", "shellEscape"}  # P1 subset; P2 (#3) adds variants, steps, render, limits
JOB_MAX = 1 << 20
# Input caps sit above the host snapshot defaults (200 MiB, 5,000 files; #3) so a valid snapshot always fits.
INPUT_BYTES_MAX = 256 << 20
INPUT_ENTRIES_MAX = 10_000
# Output caps per artifact; an oversize artifact is omitted and listed in result.json.
OUTPUT_MAX = {"pdf": 512 << 20, "log": 64 << 20, "fls": 16 << 20}
PROTOCOL = "send the tar stream atex builds (stream protocol v1, issue #3)"


class InputError(Exception):
    def __init__(self, cause, next_step=PROTOCOL):
        super().__init__(cause)
        self.next_step = next_step


def safe_rel(name):
    """Return a normalized relative path under src/, or None for the job entry; reject anything else."""
    if name.startswith("/") or "\\" in name:
        raise InputError(f"input tar entry {name!r} is absolute or uses backslashes")
    norm = posixpath.normpath(name)
    if norm == ".atex/job.json":
        return None
    if norm == "src":
        return ""
    if not norm.startswith("src/") or ".." in norm.split("/"):
        raise InputError(f"input tar entry {name!r} is outside src/")
    return norm[4:]


def read_input():
    job = None
    total = 0
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
        for count, member in enumerate(tar, 1):
            total += max(member.size, 0)
            if count > INPUT_ENTRIES_MAX or total > INPUT_BYTES_MAX:
                raise InputError(f"input tar exceeds {INPUT_ENTRIES_MAX} entries or {INPUT_BYTES_MAX >> 20} MiB",
                                 "exclude large or generated files from the snapshot ([snapshot] exclude in atex.toml)")
            rel = safe_rel(member.name)
            if rel is None:
                if not member.isfile() or member.size > JOB_MAX:
                    raise InputError(".atex/job.json must be a regular file under 1 MiB")
                job = json.loads(tar.extractfile(member).read().decode("utf-8"))
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
                raise InputError(f"input tar entry {member.name!r} is not a regular file or directory",
                                 "replace links and special files in the project with regular files")
    if not isinstance(job, dict) or job.get("v") != 1:
        raise InputError("input tar has no .atex/job.json with v: 1")
    unknown = sorted(set(job) - JOB_KEYS)
    if unknown:
        raise InputError(f"job.json has fields this image does not support: {', '.join(unknown)}",
                         "use an atex release that matches this image (atex env check)")
    main = job.get("main")
    if not isinstance(main, str) or not main.endswith(".tex") or main.startswith("/") or ".." in main.split("/"):
        raise InputError("job.main must be a relative .tex path inside the project", "set main in atex.toml to a .tex file inside the project")
    if not os.path.isfile(os.path.join(SRC, main)):
        raise InputError(f"job.main {main!r} is not in the snapshot", "set main in atex.toml to a .tex file that exists and is not excluded")
    if job.get("engine", "pdflatex") not in ENGINES:
        raise InputError(f"job.engine must be one of {', '.join(ENGINES)}", "set engine in atex.toml to pdflatex, xelatex or lualatex")
    if job.get("shellEscape", "restricted") not in ("restricted", "unrestricted"):
        raise InputError("job.shellEscape must be restricted or unrestricted")
    epoch = job.get("dateEpoch", 0)
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        raise InputError("job.dateEpoch must be a non-negative integer")
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
        info = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True, check=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in info.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return None


def add_bytes(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    tar.addfile(info, io.BytesIO(data))


def add_file(tar, name, path, result):
    """Stream one artifact into the tar, refusing anything over its cap. Returns its sha256 or None."""
    size = os.path.getsize(path)
    cap = OUTPUT_MAX[name.rsplit(".", 1)[-1]]
    if size > cap:
        result["omitted"].append({"path": name, "bytes": size, "cap": cap})
        return None
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 16):
            digest.update(chunk)
        f.seek(0)
        info = tarfile.TarInfo(name)
        info.size = size
        info.mode = 0o644
        tar.addfile(info, f)
    return digest.hexdigest()


def main():
    try:
        job = read_input()
    except InputError as err:
        sys.stderr.write(f"atex-run: {err}\n  next: {err.next_step}\n")
        return 2
    except (tarfile.TarError, ValueError, OSError) as err:  # ValueError covers JSON and UTF-8 decoding
        sys.stderr.write(f"atex-run: unreadable input ({type(err).__name__}: {err})\n  next: {PROTOCOL}\n")
        return 2
    main_tex = job["main"]
    engine = job.get("engine", "pdflatex")
    cwd = os.path.join(SRC, posixpath.dirname(main_tex))
    name = posixpath.basename(main_tex)[: -len(".tex")]
    # -norc: no latexmkrc from the project or the image runs; project configuration needs an explicit opt-in (later phase).
    cmd = ["latexmk", "-norc", ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-recorder"]
    if job.get("shellEscape") == "unrestricted":
        cmd.append("-shell-escape")
    cmd.append(posixpath.basename(main_tex))
    started = time.monotonic()
    # latexmk's stdout goes to stderr: stdout carries only the result tar.
    code = subprocess.run(cmd, cwd=cwd, env=environment(job), stdin=subprocess.DEVNULL, stdout=sys.stderr.fileno()).returncode
    seconds = round(time.monotonic() - started, 3)
    pdf = os.path.join(cwd, f"{name}.pdf")
    result = {"v": 1, "status": "failed", "steps": [{"name": "latexmk", "exitCode": code, "seconds": seconds}], "outputs": [], "omitted": []}
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        if code == 0 and os.path.isfile(pdf):
            sha = add_file(tar, f"out/{name}.pdf", pdf, result)
            if sha:
                result["status"] = "ok"
                result["outputs"].append({"variant": "default", "path": f"out/{name}.pdf", "sha256": sha, "pages": pages(pdf)})
        for ext, folder in (("log", "log"), ("fls", "deps")):
            path = os.path.join(cwd, f"{name}.{ext}")
            if os.path.isfile(path):
                add_file(tar, f"{folder}/{name}.{ext}", path, result)
        add_bytes(tar, "result.json", json.dumps(result, separators=(",", ":")).encode())
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
