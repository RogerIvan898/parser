FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Bothost bind-mounts Git over /app and hides image build output. Keep code outside /app.
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

COPY . .
RUN npm run build:all \
  && test -f dist/server.js \
  && test -f dist/db/schema.sql \
  && test -f web/dist/index.html

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3000

CMD ["node", "/usr/src/app/boot.js"]
