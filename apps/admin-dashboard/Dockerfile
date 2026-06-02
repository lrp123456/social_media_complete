FROM node:20-slim

WORKDIR /app

COPY apps/admin-dashboard/package.json apps/admin-dashboard/next.config.js apps/admin-dashboard/tsconfig.json apps/admin-dashboard/tailwind.config.js apps/admin-dashboard/postcss.config.js apps/admin-dashboard/.npmrc ./
COPY apps/admin-dashboard/src/ ./src/
COPY apps/admin-dashboard/public/ ./public/

RUN npm install && npm run build

EXPOSE 3000
CMD ["npm", "start"]
