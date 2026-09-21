FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY vendor ./vendor
RUN npm ci
COPY .flow ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
ARG PAX_VERSION=0.1.0
RUN curl --fail --location --silent --show-error \
    "https://github.com/rkendel1/pax/releases/download/v${PAX_VERSION}/pax-${PAX_VERSION}-x86_64-unknown-linux-gnu.tar.gz" \
    | tar -xz -C /usr/local/bin \
  && chmod 0755 /usr/local/bin/pax \
  && pax --version

WORKDIR /app
ENV NODE_ENV=production
ENV FACTORY_PORT=3000
ENV PAX_BIN=/usr/local/bin/pax
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/.flow ./.flow
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["node", "dist/src/server.js"]
