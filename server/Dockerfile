# syntax=docker/dockerfile:1

# Контекст сборки — корень репозитория: сервер разделяет с фронтендом файл
# протокола сигналинга, чтобы проверка входящих сообщений была ровно одна.
FROM node:22-alpine AS build
WORKDIR /build

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund

COPY server/tsconfig.json ./server/
COPY server/src ./server/src

# Корневой package.json нужен не ради зависимостей, а ради "type": "module":
# под NodeNext модульную систему файла определяет ближайший сверху package.json.
# Без него общий src/protocol/signaling.ts считается CommonJS, и сборка падает
# на каждом export — при том что локально всё собирается.
COPY package.json ./
COPY src/protocol/signaling.ts ./src/protocol/
COPY src/signaling/types.ts ./src/signaling/
COPY src/bytes.ts ./src/

RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Свой пользователь: ретранслятор чужих блобов не должен ходить под root.
USER node

COPY --from=build --chown=node:node /build/server/node_modules ./node_modules
COPY --from=build --chown=node:node /build/server/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/src/index.js"]
