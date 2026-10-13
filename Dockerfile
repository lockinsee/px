FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

# Dependency manifests first so installs are cached between code changes.
# vendor/ and patches/ are referenced by package.json, so they must be present before install.
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
COPY patches ./patches
RUN pnpm install --frozen-lockfile --prod

COPY . .

EXPOSE 8080
CMD ["node", "src/server.js"]
