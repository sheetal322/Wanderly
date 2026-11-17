# One Dockerfile for every backend service; APP selects the entrypoint.
# Stages: deps -> build -> runtime. The runtime image carries no TypeScript
# compiler and no dev dependencies.
ARG NODE_VERSION=22-alpine

# ---------- deps: full install, cached on lockfile only ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY libs/config/package.json libs/config/
COPY libs/db/package.json libs/db/
RUN npm ci

# ---------- build: compile the whole workspace ----------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
# npm hoists every dependency to the root node_modules, so there is nothing
# per-workspace to copy.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Also runs `prisma generate`, which writes the client and a query engine built
# for this image's platform (musl) into node_modules/.prisma.
RUN npm run build

# ---------- prod-deps: production-only node_modules ----------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY libs/config/package.json libs/config/
COPY libs/db/package.json libs/db/
# --omit=optional too: the prisma CLI (and typescript with it) is an optional
# peer of @prisma/client, which npm keeps under --omit=dev alone. Migrations run
# from the build stage, so the runtime needs neither (~180 MB).
RUN npm ci --omit=dev --omit=optional

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ARG APP=api
ENV NODE_ENV=production APP=${APP}
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
# The generated Prisma client: prod-deps has no prisma CLI to generate it.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/libs/config/dist ./libs/config/dist
COPY --from=build /app/libs/config/package.json ./libs/config/package.json
COPY --from=build /app/libs/db/dist ./libs/db/dist
COPY --from=build /app/libs/db/package.json ./libs/db/package.json
COPY --from=build /app/apps/${APP}/dist ./apps/${APP}/dist
COPY --from=build /app/apps/${APP}/package.json ./apps/${APP}/package.json
COPY package.json ./

USER node
CMD ["sh", "-c", "node apps/${APP}/dist/main.js"]
