# syntax=docker/dockerfile:1

# RealPay: one container serves the API and the static browser client.
# Node 24 runs the TypeScript sources directly (type stripping), so there
# is no build step and no TypeScript tooling in the runtime image.

FROM node:24-slim AS deps
WORKDIR /app/server/node
# better-sqlite3 compiles from source when no prebuilt binary matches the
# platform. This stage is discarded, so the toolchain never ships.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++
COPY server/node/package.json server/node/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/realpay.db \
    UPLOAD_DIR=/data/uploads
WORKDIR /app/server/node
COPY --from=deps /app/server/node/node_modules ./node_modules
COPY server/node/package.json ./
COPY server/node/src ./src
COPY client /app/client
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
