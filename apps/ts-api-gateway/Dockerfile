FROM node:20-slim

# 安装 Chromium 依赖 + FFmpeg（用于 OSS 下载验证）
RUN apt-get update && apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  fonts-liberation fonts-noto-cjk \
  chromium \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/

RUN pnpm build

EXPOSE 3001

CMD ["node", "dist/index.js"]
