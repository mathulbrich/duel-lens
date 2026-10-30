# A slow computer for the extension's latency runs (run.sh): Debian's Chromium and Firefox ESR on Linux,
# with no GPU. run.sh mounts the repository at /repo, with Linux node_modules in named volumes.
FROM node:22-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium firefox-esr fonts-noto-core fonts-noto-cjk procps \
  && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_SKIP_DOWNLOAD=1 DUEL_LENS_E2E_CHROME=/usr/bin/chromium FIREFOX_BIN=/usr/bin/firefox-esr DUEL_LENS_E2E_NO_GPU=1
WORKDIR /repo
