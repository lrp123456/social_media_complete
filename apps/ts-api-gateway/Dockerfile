FROM node:20-slim

RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

WORKDIR /app

# 保留 monorepo 目录结构，使 file:../../packages/ 路径正确
COPY packages/ packages/
COPY apps/ts-api-gateway/ apps/ts-api-gateway/

WORKDIR /app/apps/ts-api-gateway

RUN npm install && npm run build

CMD ["node", "dist/index.js"]
