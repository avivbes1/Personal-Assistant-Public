# besinsky-bot — Dockerfile
#
# Base: node:22-slim (Debian bookworm). Multi-arch — supports arm64 (this server
# runs on AWS Graviton/ARM) as well as amd64.
#
# Chromium is installed from Debian apt (NOT snap) so whatsapp-web.js/puppeteer
# can drive a real headless browser. Puppeteer's own Chromium download is skipped;
# we point it at the system binary via CHROMIUM_PATH=/usr/bin/chromium.
#
# Also installs ffmpeg + python3 + edge-tts for the voice-message feature, and
# build tools so the native better-sqlite3 module compiles during npm install.

FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

# ── System dependencies ──────────────────────────────────────────────────────
# chromium + fonts: headless WhatsApp Web
# ffmpeg + python3 + edge-tts: voice message generation (voice-server.js)
# build-essential + python3: compile better-sqlite3 (native addon)
# curl: container HEALTHCHECK
# ca-certificates: outbound HTTPS (Anthropic/Gemini/Google APIs)
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      python3 \
      python3-pip \
      build-essential \
      curl \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
    && pip3 install --break-system-packages --no-cache-dir edge-tts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Install node deps (layer-cached unless package files change) ──────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── App source ───────────────────────────────────────────────────────────────
COPY . .

# Health/voice HTTP server
EXPOSE 3001

# Container healthcheck — hits the always-on /health endpoint (voice-server.js
# now binds on module load, so this passes even while WhatsApp is still linking).
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
