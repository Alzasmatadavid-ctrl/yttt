# KAI · imagen única: el servidor sirve la API y la aplicación web.
# Construir:  docker build -t kai .
# Ejecutar:   docker run -p 3000:3000 --env-file .env -e NODE_ENV=production -e SERVE_FRONTEND=true kai
#   - Con --env-file, las variables del .env pisan los ENV de esta imagen: los -e del final garantizan el modo
#     producción y que se sirva la web aunque tu .env diga otra cosa (los -e tienen prioridad sobre --env-file).
#   - En producción el .env debe incluir al menos DATABASE_URL (PostgreSQL), ENCRYPTION_KEY y APP_URL.
#   - Con docker compose (docker-compose.yml) no hace falta nada de esto: ya fija esas variables.

# ── 1) Compilación ───────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY backend backend
COPY frontend frontend
RUN npm run build

# ── 2) Ejecución ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    SERVE_FRONTEND=true \
    FRONTEND_DIST=../frontend/dist \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --omit=dev --workspace backend --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist

USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
