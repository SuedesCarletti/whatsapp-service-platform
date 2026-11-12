FROM node:20-slim
WORKDIR /app/frontend/src/services/baileys-bridge
COPY frontend/src/services/baileys-bridge/package*.json ./
RUN npm ci --omit=dev
COPY frontend/src/services/baileys-bridge/ ./
CMD ["node", "index.js"]
