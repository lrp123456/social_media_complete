FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

EXPOSE 3001

CMD ["node", "dist/index.js"]
