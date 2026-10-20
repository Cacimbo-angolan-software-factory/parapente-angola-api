# Apply the small fix on top of the exact saved production image. No dependency
# upgrades or database migrations are bundled into this incident repair.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /app
COPY --chown=node:node src/server.js src/managedProfile.js ./src/
COPY --chown=node:node package.json package-lock.json ./
