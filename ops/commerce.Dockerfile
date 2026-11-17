ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /app
COPY --chown=node:node src/server.js src/commerce.js ./src/
COPY --chown=node:node db/011_public_commerce.sql ./db/
COPY --chown=node:node package.json package-lock.json ./
