#!/usr/bin/env python3
"""Input refusals of atex-run, checked on the host: every case fails before latexmk runs, so no TeX is needed.

Usage: python3 image/test-atex-run.py
"""
import contextlib
import importlib.util
import io
import os
import sys
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location("atex_run", os.path.join(os.path.dirname(os.path.abspath(__file__)), "atex-run.py"))
atex_run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atex_run)

JOB = b'{"v": 1, "main": "a.tex"}'


def tar(*entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "link":
                info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
            else:
                info.size = len(data)
            t.addfile(info, io.BytesIO(data) if kind != "link" else None)
    return buf.getvalue()


def use(work):
    atex_run.WORK = work
    atex_run.SRC, atex_run.EXT, atex_run.MANIFEST = (os.path.join(work, n) for n in ("src", "ext", "sources.json"))


def run(payload):
    with tempfile.TemporaryDirectory() as work:
        return run_in(work, payload)


def run_in(work, payload):
    use(work)
    stdin, err = sys.stdin, io.StringIO()
    sys.stdin = io.TextIOWrapper(io.BytesIO(payload))
    try:
        with contextlib.redirect_stderr(err):
            code = atex_run.main()
    finally:
        sys.stdin = stdin
    return code, err.getvalue()


CASES = {
    "garbage instead of a tar": (b"not a tar stream" * 64, "unreadable input"),
    "malformed job JSON": (tar((".atex/job.json", b"{v:", "file"), ("src/a.tex", b"x", "file")), "unreadable input"),
    "entry outside src/": (tar((".atex/job.json", JOB, "file"), ("etc/a.tex", b"x", "file")), "outside src/"),
    "path escape": (tar((".atex/job.json", JOB, "file"), ("src/../../a.tex", b"x", "file")), "outside src/"),
    "ext without a plain name": (tar((".atex/job.json", JOB, "file"), ("ext/$x/a.sty", b"x", "file")), "outside src/"),
    "source before the job": (tar(("src/a.tex", b"x", "file"), (".atex/job.json", JOB, "file")), "must start with .atex/job.json"),
    "symlink": (tar((".atex/job.json", JOB, "file"), ("src/a.tex", b"", "link")), "not a regular file"),
    "no job": (tar(("src/a.tex", b"x", "file")), ".atex/job.json"),
    "unknown job field": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "steps": []}', "file"), ("src/a.tex", b"x", "file")), "does not support: steps"),
    "variant with an unsafe option": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "variants": [{"name": "h", "classOptions": ["}\\\\x"]}]}', "file"), ("src/a.tex", b"x", "file")), "job.variants"),
    "duplicate variant": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "variants": [{"name": "h"}, {"name": "h"}]}', "file"), ("src/a.tex", b"x", "file")), "job.variants"),
    "fresh of the wrong type": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "fresh": "yes"}', "file"), ("src/a.tex", b"x", "file")), "job.fresh"),
    "main not in snapshot": (tar((".atex/job.json", JOB, "file"),), "not in the snapshot"),
    "engine of the wrong type": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "engine": ["pdflatex"]}', "file"), ("src/a.tex", b"x", "file")), "job.engine"),
    "shellEscape of the wrong type": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "shellEscape": {}}', "file"), ("src/a.tex", b"x", "file")), "job.shellEscape"),
    "bad engine": (tar((".atex/job.json", b'{"v": 1, "main": "a.tex", "engine": "tectonic"}', "file"), ("src/a.tex", b"x", "file")), "job.engine"),
}


def sync_ok():
    """T2 (#3): a source missing from the next snapshot leaves the volume; intermediates stay; fresh empties src/."""
    with tempfile.TemporaryDirectory() as work:
        use(work)
        atex_run.read_input(io.BytesIO(tar((".atex/job.json", JOB, "file"), ("src/a.tex", b"x", "file"), ("src/old.tex", b"o", "file"))))
        open(os.path.join(work, "src", "a.aux"), "w").close()
        atex_run.read_input(io.BytesIO(tar((".atex/job.json", JOB, "file"), ("src/a.tex", b"x", "file"))))
        kept = sorted(os.listdir(os.path.join(work, "src")))
        fresh = b'{"v": 1, "main": "a.tex", "fresh": true}'
        atex_run.read_input(io.BytesIO(tar((".atex/job.json", fresh, "file"), ("src/a.tex", b"x", "file"))))
        after = sorted(os.listdir(os.path.join(work, "src")))
        # main must be in this snapshot: a copy left by the previous build does not count, and the refusal discards the cache.
        stale = b'{"v": 1, "main": "a.tex"}'
        try:
            atex_run.read_input(io.BytesIO(tar((".atex/job.json", stale, "file"), ("src/b.tex", b"x", "file"))))
            refused = False
        except atex_run.InputError:
            refused = True
    with tempfile.TemporaryDirectory() as work:
        use(work)
        code, _ = run_in(work, tar((".atex/job.json", JOB, "file"), ("src/a.tex", b"x", "file"), ("src/../x", b"x", "file")))
        clean = code == 2 and not os.path.exists(os.path.join(work, "src")) and not os.path.exists(os.path.join(work, "sources.json"))
    ok = kept == ["a.aux", "a.tex"] and after == ["a.tex"] and refused and clean
    print(f"{'ok  ' if ok else 'FAIL'} sync, fresh, stale main and discard" + ("" if ok else f": {kept} then {after}, refused={refused}, clean={clean}"))
    return ok


def main():
    failures = 0
    for label, (payload, expected) in CASES.items():
        code, err = run(payload)
        ok = code == 2 and expected in err and "next: " in err and "Traceback" not in err
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {label}" + ("" if ok else f": exit {code}, stderr {err!r}"))
    failures += not sync_ok()
    atex_run.INPUT_ENTRIES_MAX = 2
    code, err = run(tar((".atex/job.json", JOB, "file"), ("src/a.tex", b"x", "file"), ("src/b.tex", b"x", "file")))
    ok = code == 2 and "exceeds" in err and "next: " in err
    failures += not ok
    print(f"{'ok  ' if ok else 'FAIL'} entry cap" + ("" if ok else f": exit {code}, stderr {err!r}"))
    atex_run.INPUT_ENTRIES_MAX, atex_run.INPUT_BYTES_MAX, atex_run.HEADER_ROOM = 10_000, 0, 0
    code, err = run(b"\0" * 4096)  # the raw budget refuses before tarfile parses a header
    ok = code == 2 and "input stream exceeds" in err and "next: " in err
    failures += not ok
    print(f"{'ok  ' if ok else 'FAIL'} raw stream budget" + ("" if ok else f": exit {code}, stderr {err!r}"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
