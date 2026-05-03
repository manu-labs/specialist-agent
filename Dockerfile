# syntax=docker/dockerfile:1.6
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-slim AS dev-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:20-slim AS runtime
WORKDIR /app
# git is required at runtime — every tenant workspace is a git repo and
# the agent commits skills on each successful synthesis.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

# Source + tsx (kept in node_modules for runtime via dev-deps stage,
# since we ship TS directly rather than precompile).
COPY --from=dev-deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# Drop privileges. Tenant volume is mounted read-write at the path
# Railway exposes via RAILWAY_VOLUME_MOUNT_PATH; chown is applied by
# Railway on volume attach.
RUN useradd -r -u 10001 specialist && chown -R specialist /app
USER specialist

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/server/main.ts"]
