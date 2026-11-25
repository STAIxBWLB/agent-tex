# Image contents and licenses

Everything in the atex image may be redistributed. This list covers what `image/Dockerfile` adds to the base and the base itself; update it in the same change that adds a package.

| Component | Source | License |
|---|---|---|
| TeX Live scheme-full | base `texlive/texlive:latest-full` (Island of TeX) | TeX Live admits only free software; per-package licenses in the TeX Live database (LPPL, GPL, OFL, public domain and others) |
| Debian base system | base image | Debian Free Software Guidelines (per package in `/usr/share/doc/*/copyright`) |
| Noto CJK fonts (`fonts-noto-cjk`) | Debian | SIL Open Font License 1.1 |
| poppler-utils | Debian | GPL-2.0 or GPL-3.0 |
| qpdf | Debian | Apache-2.0 |
| pandoc | Debian | GPL-2.0-or-later |
| ImageMagick | Debian | ImageMagick License (Apache-2.0 style) |
| Python 3 | Debian | Python Software Foundation License |
| `atex-run` | this repository | MIT |

No font or binary in the image needs a separate license review. Projects that need other fonts carry them as source assets; they are never added to the image.
