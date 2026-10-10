# One image recipe for every Node workspace package. Build from the repo root:
#   docker build -f images/node/Dockerfile --build-arg PKG=woo-mcp -t urumi/woo-mcp:dev .
# The gateway image also carries the built dashboard (served as static files).
FROM node:24.21.0-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/woo-mcp/package.json packages/woo-mcp/
COPY packages/demo-upstream/package.json packages/demo-upstream/
COPY packages/gateway/package.json packages/gateway/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci --no-audit --no-fund
COPY packages packages
ARG PKG
RUN npm run build -w @urumi/shared --if-present \
 && npm run build -w @urumi/${PKG} \
 && if [ "$PKG" = "gateway" ]; then npm run build -w @urumi/dashboard; fi \
 && mkdir -p packages/dashboard/dist \n && npm prune --omit=dev

FROM node:24.21.0-alpine
ARG PKG
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src/node_modules node_modules
COPY --from=build --chown=node:node /src/packages/shared packages/shared
COPY --from=build --chown=node:node /src/packages/${PKG} packages/${PKG}
COPY --from=build --chown=node:node /src/packages/dashboard/dist packages/dashboard/dist
USER node
WORKDIR /app/packages/${PKG}
EXPOSE 8080
CMD ["node", "dist/index.js"]
