FROM node:20-slim

RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && apt-get install -y openssl --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制所有源码
COPY prisma/ prisma/
COPY packages/ packages/
COPY apps/ts-api-gateway/ apps/ts-api-gateway/

# 安装 workspace 包的依赖
RUN cd /app/packages/browser-core && npm install
RUN cd /app/packages/shared-config && npm install
RUN cd /app/packages/selectors && npm install

WORKDIR /app/apps/ts-api-gateway
RUN npm install

# 生成 Prisma Client
RUN npx prisma generate --schema /app/prisma/schema.prisma

CMD ["npx", "tsx", "src/index.ts"]
