FROM node:20-slim

WORKDIR /app

# Copy source files
COPY apps/admin-dashboard/package.json apps/admin-dashboard/next.config.js apps/admin-dashboard/tsconfig.json apps/admin-dashboard/tailwind.config.js apps/admin-dashboard/postcss.config.js apps/admin-dashboard/.npmrc ./
COPY apps/admin-dashboard/src/ ./src/
COPY apps/admin-dashboard/public/ ./public/

# Build (output: standalone 模式生成 .next/standalone/)
RUN npm install && npm run build

# Standalone 模式：静态资源需从 .next/static 复制到 standalone 内部
RUN cp -r .next/static .next/standalone/.next/static && \
    cp -r public .next/standalone/public

EXPOSE 3000

# standalone server（需 docker-compose 中设置 HOSTNAME=0.0.0.0 否则只绑定 127.0.1.1）
CMD ["node", ".next/standalone/server.js"]
