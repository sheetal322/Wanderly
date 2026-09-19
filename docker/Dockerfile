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
RUN npm ci

# ---------- build: compile the whole workspace ----------
FROM node:${NODE_VERSION} AS build
WORKDIR /app
# npm hoists every dependency to the root node_modules, so there is nothing
# per-workspace to copy.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- prod-deps: production-only node_modules ----------
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY libs/config/package.json libs/config/
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
ARG APP=api
ENV NODE_ENV=production APP=${APP}
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/libs/config/dist ./libs/config/dist
COPY --from=build /app/libs/config/package.json ./libs/config/package.json
COPY --from=build /app/apps/${APP}/dist ./apps/${APP}/dist
COPY --from=build /app/apps/${APP}/package.json ./apps/${APP}/package.json
COPY package.json ./

USER node
CMD ["sh", "-c", "node apps/${APP}/dist/main.js"]
