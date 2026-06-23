FROM node:20-slim

RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y openssl --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制所有源码
COPY prisma/ prisma/
COPY packages/ packages/
COPY apps/ts-api-gateway/ apps/ts-api-gateway/
COPY apps/ts-api-gateway/data/selectors.json /app/bundled-selectors.json

# 安装 workspace 包的依赖
# 使用 --omit=dev 跳过 devDependencies（prisma CLI、typescript），避免 dev 树中
# 传递依赖（prisma → c12 → citty → vitest peer）触发 ERESOLVE 冲突
# 使用 --legacy-peer-deps 兼容 pnpm file: 链的 peer dep
RUN cd /app/packages/browser-core && npm install --omit=dev --legacy-peer-deps
RUN cd /app/packages/shared-config && npm install --omit=dev --legacy-peer-deps
RUN cd /app/packages/selectors && npm install --omit=dev --legacy-peer-deps

WORKDIR /app/apps/ts-api-gateway
RUN npm install --legacy-peer-deps
RUN npm install @wecom/aibot-node-sdk --legacy-peer-deps

# 生成 Prisma Client + 同步数据库结构
RUN npx prisma generate --schema /app/prisma/schema.prisma

CMD npx prisma db push --schema /app/prisma/schema.prisma --accept-data-loss && npx tsx src/index.ts
