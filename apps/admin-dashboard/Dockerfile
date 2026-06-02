FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY next.config.js tsconfig.json tailwind.config.js postcss.config.js ./
COPY src/ ./src/
COPY public/ ./public/

RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
