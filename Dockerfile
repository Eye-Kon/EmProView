# EmProView Node application image.
# Runtime-only: dev dependencies are excluded and the container runs as the
# unprivileged "node" user. Configuration is injected entirely via
# environment variables (see docker-compose.yml).
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first so source edits do not bust the npm layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

USER node

EXPOSE 3000

CMD ["node", "server.js"]
