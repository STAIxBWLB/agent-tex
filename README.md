# agent-tex (`atex`)

Container-only LaTeX and Beamer builds for coding agents, part of the agent family (ahub, amem, vmem, acon, ares, adec). The host needs no TeX installation: sources are copied into a pinned container, built there, and only the PDF comes back. Builds return structured diagnostics and page renders, over a CLI and an MCP server.

Status: P1 (environment image). The plan of record and delivery phases are in issue #1.

## Commands

```sh
atex env check [--json]   # container runtime, pinned image present or not
atex env pull [--json]    # pull the pinned image
```

Exit codes: 0 ready, 2 usage error, 3 runtime or image missing.

## Environment image

`image/` holds the image: TeX Live scheme-full with latexmk, biber, Noto CJK, poppler-utils, qpdf, pandoc and ImageMagick, plus the in-container runner `atex-run`. It is built for `linux/amd64` and `linux/arm64` and published as `ghcr.io/staixbwlb/agent-tex:<TeX Live year>.<build>`; each atex release pins one digest in `src/image.ts`. Licenses: `image/LICENSES.md`.

Fixtures run inside the image with no network, a read-only root, a non-root user and no capabilities:

```sh
docker build -t atex:test image && python3 image/test-fixtures.py atex:test
```

## License

MIT, STAIx Inc.
