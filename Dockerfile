FROM docker:28.5.2-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli
FROM node:24.11.1-bookworm-slim@sha256:48abc13a19400ca3985071e287bd405a1d99306770eb81d61202fb6b65cf0b57
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@11.11.0 --ignore-scripts
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/opticpr
COPY . .
RUN pnpm install --frozen-lockfile && pnpm db:generate && pnpm build
ENV NODE_ENV=production HOST=127.0.0.1 PORT=3000
USER node
CMD ["node", "apps/api/dist/main.js"]
