# Changelog

## Unreleased

- Environment image (`image/`): TeX Live scheme-full on a digest-pinned multi-arch base, Noto CJK, poppler-utils, qpdf, pandoc, ImageMagick, and the `atex-run` runner (stream protocol v1 subset), with eight fixtures run under no network, read-only root, non-root and no capabilities (#2).
- `atex env check` and `atex env pull`, with `--json` and exit code 3 when the runtime or the pinned image is missing (#2).
