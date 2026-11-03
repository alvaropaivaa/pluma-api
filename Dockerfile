# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

# ---------- produção ----------
FROM node:22-bookworm-slim
# ffmpeg: conversão de áudio para mensagem de voz; tini: repassa sinais e recolhe processos
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* && mkdir -p /data/media && chown node:node /data/media
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# Aplica as migrações e sobe o supervisor (roteador + um worker por CPU)
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/cluster.js"]
