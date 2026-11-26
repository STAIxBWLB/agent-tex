# Changelog

## Unreleased

- Environment image (`image/`): TeX Live scheme-full on a digest-pinned multi-arch base, Noto CJK, poppler-utils, qpdf, pandoc, ImageMagick, and the `atex-run` runner (stream protocol v1 subset), with eight fixtures run under no network, read-only root, non-root and no capabilities (#2).
- `atex env check` and `atex env pull`, with `--json` and exit code 3 when the runtime or the pinned image is missing (#2).
- Published `ghcr.io/staixbwlb/agent-tex:2026.1` (TeX Live 2026, amd64 and arm64), pinned in `src/image.ts` (#2).
- `atex --version`, and a release pipeline: a `v*` tag runs the exact-commit main CI gate, stages the npm tarball, smoke-tests it in a clean prefix, and publishes with npm OIDC provenance only when publishing is enabled; main CI stages and smoke-tests every commit.
