# ============================================================
# SIKEBUT WA Gateway — Node.js + Baileys
# Build:  docker build -t sikebut-wa .
# Run:    docker compose up -d --build
# ============================================================
FROM node:24-alpine

# Dependency untuk build native module (Baileys/libsignal kadang perlu)
RUN apk add --no-cache \
      python3 \
      make \
      g++ \
      cairo-dev \
      jpeg-dev \
      pango-dev \
      giflib-dev \
      librsvg-dev \
      pkgconfig \
      curl

WORKDIR /app

# Install dependency dulu (cache layer) sebelum copy source
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev && npm cache clean --force

# Copy source aplikasi
COPY server.js ./

# Folder untuk sesi WA + prioritas device (isi di-mount via volume)
RUN mkdir -p /app/sessions

# Jangan jalan sebagai root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001
RUN chown -R nodejs:nodejs /app
USER nodejs

# Health check pakai endpoint /health (perlu header X-Gateway-Key)
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -f -s -H "X-Gateway-Key: ${WA_GATEWAY_KEY}" \
      http://127.0.0.1:${WA_PORT:-3001}/health || exit 1

EXPOSE 3001

CMD ["node", "server.js"]
