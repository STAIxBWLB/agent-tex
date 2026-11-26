# agent-tex (`atex`)

Container-only LaTeX and Beamer builds for coding agents, part of the agent family (ahub, amem, vmem, acon, ares, adec). The host needs no TeX installation: sources are copied into a pinned container, built there, and only the PDF comes back. Builds return structured diagnostics and page renders, over a CLI and an MCP server.

Status: P2 (build core). The plan of record and delivery phases are in issue #1.

## Install

Requires Bun 1.4.2 or later and a Docker-compatible runtime (docker, podman or nerdctl). TeX is never installed on the host.

```sh
bun add -g @staix/agent-tex
atex env pull    # pulls the pinned image (several GB)
atex env check
```

## Commands

```sh
atex build [MAIN] [--out PATH] [--fresh] [--json]
atex env check [--json]   # container runtime, pinned image present or not
atex env pull [--json]    # pull the pinned image
atex --version
```

Exit codes: 0 ok, 1 document problem (no PDF changes), 2 usage or config error, 3 environment problem, 75 another build of the same project is running.

## Building

`atex build` copies the project into the container as a tar stream, runs latexmk there, and writes back only the PDF. Intermediates stay in a per-project cache volume, so an unchanged rebuild is fast; `--fresh` starts that cache over. A failed build leaves an existing PDF untouched. The last log, result and receipt go to `$XDG_STATE_HOME/atex/projects/<id>/last/` (default `~/.local/state`).

The project root is the nearest directory with `atex.toml`, else the current directory. Every key is optional:

```toml
main = "paper.tex"          # else the only root .tex file with \documentclass
engine = "xelatex"          # else % !TEX program, then fontspec/xeCJK (xelatex) or \directlua (lualatex), else pdflatex
out = "build"               # a directory, or a .pdf path for a single output; default: beside main
date = "2026-01-01"         # build date (00:00 UTC); default: today
shellEscape = "restricted"  # or "unrestricted"; the container has no network either way
latexmkrc = false           # true lets the project's latexmkrc run

[[variants]]                # one PDF per variant: <main>-<name>.pdf
name = "handout"
classOptions = ["handout"]

[snapshot]
exclude = ["data/"]         # gitignore-style, like .atexignore
extra = [{ path = "../shared", as = "shared" }]  # on the TeX search path
maxBytes = 209715200        # 200 MiB
maxFiles = 5000
```

Never sent, whatever the rules say: `.git`, `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*`, `.npmrc`, `.netrc`. Also left out by default: `node_modules`, LaTeX intermediates (`.bbl` is kept) and the output PDFs. A symlink leaving the project fails the build before any container starts.

Builds are reproducible for a fixed `date`: a `--fresh` rebuild gives the same PDF bytes and receipt id. CI asserts this for pdfLaTeX and measured it for XeLaTeX (fontspec) and LuaLaTeX, identical on amd64 and arm64 with image `2026.2`.

Container limits come from `~/.config/atex/config.toml`:

```toml
[limits]
cpus = 2
memory = "4g"
pids = 512
```

## Environment image

`image/` holds the image: TeX Live scheme-full with latexmk, biber, Noto CJK, poppler-utils, qpdf, pandoc and ImageMagick, plus the in-container runner `atex-run`. It is built for `linux/amd64` and `linux/arm64` and published as `ghcr.io/staixbwlb/agent-tex:<TeX Live year>.<build>`; each atex release pins one digest in `src/image.ts`. Licenses: `image/LICENSES.md`.

Fixtures run inside the image with no network, a read-only root, a non-root user and no capabilities:

```sh
docker build -t atex:test image && python3 image/test-fixtures.py atex:test
```

## License

MIT, STAIx Inc.
