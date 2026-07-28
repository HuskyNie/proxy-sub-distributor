FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data/config.example.json ./data/config.example.json
COPY data/clash-strategies.example.json ./data/clash-strategies.example.json

ENV CONFIG_PATH=/app/data/config.json
ENV DATA_DIR=/app/data
ENV STRATEGY_CONFIG_PATH=/app/data/clash-strategies.json
ENV NODE_ENV=production

EXPOSE 7899

CMD ["node", "src/index.js"]
