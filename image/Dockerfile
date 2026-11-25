# atex environment image: TeX Live scheme-full plus the tools atex-run calls.
# The base is pinned by its multi-arch index digest (amd64 and arm64); see issue #2.
ARG BASE=texlive/texlive:latest-full@sha256:b20c42c2a5b1be892c26e6d3b896e9aa20350528ddd0d4444d23e5925ea1545d
FROM ${BASE}

# Redistributable additions only; image/LICENSES.md lists each one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk poppler-utils qpdf pandoc imagemagick python3 \
 && rm -rf /var/lib/apt/lists/*

# Prebuild the font caches while the root file system is still writable, so the
# read-only runtime never regenerates them (luaotfload reads TEXMFSYSVAR first).
RUN fc-cache -f \
 && luaotfload-tool --update --force \
 && mkdir -p /work \
 && useradd --uid 1000 --user-group --no-create-home --home-dir /work/home atex \
 && chown atex:atex /work

COPY --chmod=0755 atex-run.py /usr/local/bin/atex-run

USER 1000:1000
WORKDIR /work
CMD ["atex-run"]
