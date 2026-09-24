FROM rust:1.96-bookworm AS pax-build

ARG PAX_COMMIT=6a53d3e86b767ea32a77c92bc3b388d8530eddd1
RUN cargo install \
    --git https://github.com/rkendel1/pax.git \
    --rev "${PAX_COMMIT}" \
    --locked \
    --root /opt/pax \
  && test "$(/opt/pax/bin/pax --version)" = "pax 0.2.0"

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
COPY --from=pax-build /opt/pax/bin/pax /usr/local/bin/pax
RUN test "$(pax --version)" = "pax 0.2.0"

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
