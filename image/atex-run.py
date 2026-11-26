#!/usr/bin/env python3
"""atex-run: the only entry point of the atex image.

Stream protocol v1 (issue #3).
stdin:  tar with `.atex/job.json` ({v: 1, main, engine, variants, dateEpoch, shellEscape, latexmkrc, fresh}),
        sources under `src/` and extras under `ext/<as>/`.
stdout: tar with `result.json`, `out/<name>.pdf` (only when every variant built), `log/<name>.log`, `deps/<name>.fls`.
The /work volume keeps `src/` and the intermediates between builds; sources missing from a new snapshot are deleted.
stderr: progress (latexmk output).
Exit: 0 built, 1 document failure (tar still written), 2 bad job or input tar (no tar written; stderr names the cause and next step).
Caps: input entries and bytes, and each output artifact (oversize artifacts are omitted and listed in result.json).
"""
import hashlib
import io
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import time

WORK = os.environ.get("ATEX_WORK", "/work")
SRC = os.path.join(WORK, "src")
EXT = os.path.join(WORK, "ext")
MANIFEST = os.path.join(WORK, "sources.json")
ENGINES = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}
JOB_KEYS = {"v", "main", "engine", "variants", "dateEpoch", "shellEscape", "latexmkrc", "fresh"}
NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
OPTION = re.compile(r"^[A-Za-z0-9=._-]{1,64}$")
CLASS = re.compile(r"\\documentclass\s*(?:\[[^\]]*\])?\s*\{\s*([A-Za-z0-9._-]+)\s*\}")
JOB_MAX = 1 << 20
# Input caps sit above the host snapshot defaults (200 MiB, 5,000 files; #3) so a valid snapshot always fits.
INPUT_BYTES_MAX = 256 << 20
INPUT_ENTRIES_MAX = 10_000
# Raw stdin budget, enforced before tarfile parses anything: member data plus generous header room per entry.
HEADER_ROOM = 8 << 10
# Output caps per artifact; an oversize artifact is omitted and listed in result.json.
OUTPUT_MAX = {"pdf": 512 << 20, "log": 64 << 20, "fls": 16 << 20}
PROTOCOL = "send the tar stream atex builds (stream protocol v1, issue #3)"
SHRINK = "exclude large or generated files from the snapshot ([snapshot] exclude in atex.toml)"
OVERSIZE_NEXT = {
    "pdf": "reduce embedded image sizes or split the document so the PDF fits the cap",
    "log": "fix the warnings that flood the log (see the first errors in the latexmk output)",
    "fls": "reduce the number of input files the build reads",
}


class Budget:
    """A read-only stream that refuses to read past a byte budget, so no input is unbounded."""

    def __init__(self, raw, limit):
        self.raw, self.left = raw, limit

    def read(self, n=-1):
        if self.left <= 0:
            raise InputError(f"input stream exceeds {(INPUT_BYTES_MAX + INPUT_ENTRIES_MAX * HEADER_ROOM) >> 20} MiB", SHRINK)
        data = self.raw.read(self.left if n is None or n < 0 else min(n, self.left))
        self.left -= len(data)
        return data


class InputError(Exception):
    def __init__(self, cause, next_step=PROTOCOL):
        super().__init__(cause)
        self.next_step = next_step


def safe_rel(name):
    """Return the normalized path under src/ or ext/<as>/, or None for the job entry; reject anything else."""
    if name.startswith("/") or "\\" in name:
        raise InputError(f"input tar entry {name!r} is absolute or uses backslashes")
    norm = posixpath.normpath(name)
    if norm == ".atex/job.json":
        return None
    parts = norm.split("/")
    if ".." in parts or parts[0] not in ("src", "ext") or (parts[0] == "ext" and (len(parts) < 2 or not NAME.match(parts[1]))):
        raise InputError(f"input tar entry {name!r} is outside src/ and ext/<as>/")
    return norm


def read_input(stdin=None):
    job = None
    total = 0
    received = []
    stream = Budget(stdin or sys.stdin.buffer, INPUT_BYTES_MAX + INPUT_ENTRIES_MAX * HEADER_ROOM)
    with tarfile.open(fileobj=stream, mode="r|") as tar:
        for count, member in enumerate(tar, 1):
            total += max(member.size, 0)
            if count > INPUT_ENTRIES_MAX or total > INPUT_BYTES_MAX:
                raise InputError(f"input tar exceeds {INPUT_ENTRIES_MAX} entries or {INPUT_BYTES_MAX >> 20} MiB", SHRINK)
            rel = safe_rel(member.name)
            if rel is None:
                if not member.isfile() or member.size > JOB_MAX:
                    raise InputError(".atex/job.json must be a regular file under 1 MiB")
                job = json.loads(tar.extractfile(member).read().decode("utf-8"))
                check_job(job)
                if job.get("fresh"):
                    shutil.rmtree(SRC, ignore_errors=True)
                shutil.rmtree(EXT, ignore_errors=True)  # extras carry no intermediates; resend them whole
                continue
            if job is None:
                raise InputError("input tar must start with .atex/job.json")
            target = os.path.join(WORK, rel)
            if member.isdir():
                if os.path.isfile(target):
                    os.remove(target)
                os.makedirs(target, exist_ok=True)
            elif member.isfile():
                if os.path.isdir(target):
                    shutil.rmtree(target)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                if rel.startswith("src/"):
                    received.append(rel[4:])
                with open(target, "wb") as out:
                    src = tar.extractfile(member)
                    while chunk := src.read(1 << 16):
                        out.write(chunk)
            else:
                raise InputError(f"input tar entry {member.name!r} is not a regular file or directory",
                                 "replace links and special files in the project with regular files")
    if job is None:
        raise InputError("input tar has no .atex/job.json")
    main = job["main"]
    if not os.path.isfile(os.path.join(SRC, main)):
        raise InputError(f"job.main {main!r} is not in the snapshot", "set main in atex.toml to a .tex file that exists and is not excluded")
    sync(received)
    return job


def sync(received):
    """Delete sources the previous build received and this one did not; intermediates stay for latexmk."""
    try:
        with open(MANIFEST) as f:
            previous = set(json.load(f))
    except (OSError, ValueError):
        previous = set()
    for rel in sorted(previous - set(received)):
        path = os.path.join(SRC, rel)
        if os.path.isfile(path) and not os.path.islink(path):
            os.remove(path)
    with open(MANIFEST, "w") as f:
        json.dump(sorted(received), f)


def check_job(job):
    if not isinstance(job, dict) or job.get("v") != 1:
        raise InputError("input tar has no .atex/job.json with v: 1")
    unknown = sorted(set(job) - JOB_KEYS)
    if unknown:
        raise InputError(f"job.json has fields this image does not support: {', '.join(unknown)}",
                         "use an atex release that matches this image (atex env check)")
    main = job.get("main")
    if not isinstance(main, str) or not main.endswith(".tex") or main.startswith("/") or ".." in main.split("/"):
        raise InputError("job.main must be a relative .tex path inside the project", "set main in atex.toml to a .tex file inside the project")
    engine = job.get("engine", "pdflatex")
    if not isinstance(engine, str) or engine not in ENGINES:
        raise InputError(f"job.engine must be one of {', '.join(ENGINES)}", "set engine in atex.toml to pdflatex, xelatex or lualatex")
    shell = job.get("shellEscape", "restricted")
    if not isinstance(shell, str) or shell not in ("restricted", "unrestricted"):
        raise InputError("job.shellEscape must be restricted or unrestricted")
    epoch = job.get("dateEpoch", 0)
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        raise InputError("job.dateEpoch must be a non-negative integer")
    for key in ("latexmkrc", "fresh"):
        if not isinstance(job.get(key, False), bool):
            raise InputError(f"job.{key} must be true or false")
    variants = job.get("variants", [])
    if not isinstance(variants, list) or len(variants) > 16:
        raise InputError("job.variants must be a list of at most 16 variants")
    names = set()
    for v in variants:
        ok = isinstance(v, dict) and set(v) <= {"name", "classOptions"} and isinstance(v.get("name"), str) and NAME.match(v["name"])
        opts = v.get("classOptions", []) if isinstance(v, dict) else None
        if not ok or not isinstance(opts, list) or not all(isinstance(o, str) and OPTION.match(o) for o in opts) or v["name"] in names:
            raise InputError("job.variants entries need a distinct plain name and plain classOptions",
                             "use names and options made of letters, digits, . _ - and =")
        names.add(v["name"])


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
    if os.path.isdir(EXT):
        # `//` searches subdirectories; the trailing `:` keeps the default TeX search path.
        search = "".join(f"{os.path.join(EXT, d)}//:" for d in sorted(os.listdir(EXT)))
        env.update(TEXINPUTS=search, BIBINPUTS=search, BSTINPUTS=search)
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


def omit(name, size, result):
    kind = name.rsplit(".", 1)[-1]
    cap = OUTPUT_MAX[kind]
    result["omitted"].append({"path": name, "bytes": size, "cap": cap, "next": OVERSIZE_NEXT[kind]})
    sys.stderr.write(f"atex-run: {name} is {size} bytes, over its {cap}-byte cap; omitted\n  next: {OVERSIZE_NEXT[kind]}\n")


def add_file(tar, name, path, result):
    """Stream one artifact into the tar, refusing anything over its cap. Returns its sha256 or None."""
    size = os.path.getsize(path)
    if size > OUTPUT_MAX[name.rsplit(".", 1)[-1]]:
        omit(name, size, result)
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
        sys.stderr.write(f"atex-run: unreadable input ({type(err).__name__}: {err})\n  next: {PROTOCOL}; atex build --fresh clears the cached copy\n")
        return 2
    main_tex = job["main"]
    engine = job.get("engine", "pdflatex")
    cwd = os.path.join(SRC, posixpath.dirname(main_tex))
    base = posixpath.basename(main_tex)[: -len(".tex")]
    with open(os.path.join(SRC, main_tex), encoding="utf-8", errors="replace") as f:
        match = CLASS.search(f.read())
    variants = job.get("variants") or [{"name": None}]
    env = environment(job)
    result = {"v": 1, "status": "ok", "steps": [], "outputs": [], "omitted": []}
    built = []
    for variant in variants:
        name = f"{base}-{variant['name']}" if variant["name"] else base
        # -norc: no latexmkrc runs unless atex.toml opts in (latexmkrc = true).
        cmd = ["latexmk"] + ([] if job.get("latexmkrc") else ["-norc"])
        cmd += [ENGINES[engine], "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-recorder", f"-jobname={name}"]
        if job.get("shellEscape") == "unrestricted":
            cmd.append("-shell-escape")
        options = variant.get("classOptions") or []
        if options and match:
            cmd.append(f"-usepretex=\\PassOptionsToClass{{{','.join(options)}}}{{{match.group(1)}}}")
        cmd.append(posixpath.basename(main_tex))
        pdf = os.path.join(cwd, f"{name}.pdf")
        before = os.stat(pdf).st_mtime_ns if os.path.isfile(pdf) else None
        started = time.monotonic()
        # latexmk's stdout goes to stderr: stdout carries only the result tar.
        code = subprocess.run(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=sys.stderr.fileno()).returncode
        after = os.stat(pdf).st_mtime_ns if os.path.isfile(pdf) else None
        step = "latexmk" if not variant["name"] else f"latexmk:{variant['name']}"
        result["steps"].append({"name": step, "exitCode": code, "seconds": round(time.monotonic() - started, 3),
                                "upToDate": code == 0 and before is not None and before == after})
        built.append((name, variant["name"] or "default", pdf))
        if code != 0 or after is None:
            result["status"] = "failed"
            break
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT) as tar:
        # The host takes every PDF or none: check every size before adding the first.
        if result["status"] == "ok" and any(os.path.getsize(pdf) > OUTPUT_MAX["pdf"] for _, _, pdf in built):
            result["status"] = "failed"
            for name, _, pdf in built:
                if os.path.getsize(pdf) > OUTPUT_MAX["pdf"]:
                    omit(f"out/{name}.pdf", os.path.getsize(pdf), result)
        if result["status"] == "ok":
            for name, variant, pdf in built:
                sha = add_file(tar, f"out/{name}.pdf", pdf, result)
                result["outputs"].append({"variant": variant, "path": f"out/{name}.pdf", "sha256": sha, "pages": pages(pdf)})
        for name, _, _ in built:
            for ext, folder in (("log", "log"), ("fls", "deps")):
                path = os.path.join(cwd, f"{name}.{ext}")
                if os.path.isfile(path):
                    add_file(tar, f"{folder}/{name}.{ext}", path, result)
        add_bytes(tar, "result.json", json.dumps(result, separators=(",", ":")).encode())
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
