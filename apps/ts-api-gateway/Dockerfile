FROM node:20-slim

# apt 阿里云源（加速 apt-get）
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources

WORKDIR /app

# npm 淘宝镜像源
COPY apps/ts-api-gateway/.npmrc ./
COPY packages/browser-core/package.json packages/browser-core/tsconfig.json packages/browser-core/
COPY packages/browser-core/src/ packages/browser-core/src/
COPY packages/shared-config/package.json packages/shared-config/tsconfig.json packages/shared-config/
COPY packages/shared-config/src/ packages/shared-config/src/
COPY packages/selectors/package.json packages/selectors/tsconfig.json packages/selectors/
COPY packages/selectors/src/ packages/selectors/src/

COPY apps/ts-api-gateway/package.json apps/ts-api-gateway/tsconfig.json ./
COPY apps/ts-api-gateway/src/ ./src/

RUN npm install

EXPOSE 3001
CMD ["node", "dist/index.js"]
