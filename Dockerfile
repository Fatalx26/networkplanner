# =============================================================================
# Network Planner (Rack Planner) — container image
#
# Image:   docker pull ghcr.io/fatalx26/networkplanner
# Run:     docker run -d -p 8080:8080 -v networkplanner-data:/data ghcr.io/fatalx26/networkplanner
# Source:  https://github.com/Fatalx26/networkplanner
#
# The image contains:
#   /app/server.js   tiny Node.js web server (no npm dependencies)
#   /app/public/     the browser application (HTML/CSS/JS, no build step)
#   /data            volume where the rack layout is saved (layout.json)
# =============================================================================

# Small official Node.js base image (Alpine Linux). Published for amd64 & arm64,
# so the same Dockerfile builds for PCs, servers, Raspberry Pi and Apple Silicon.
FROM node:22-alpine

# Version stamped into the image metadata; override with --build-arg VERSION=x.y.z
ARG VERSION=1.0.0

# OCI annotations — shown by `docker inspect` and on Docker Hub.
LABEL org.opencontainers.image.title="Network Planner" \
      org.opencontainers.image.description="Drag-and-drop server rack designer with port-to-port cable tracking. Build racks of any size, place switches/patch panels/servers, click two ports to connect them, click either end to highlight the other." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.vendor="BigBadNetwork" \
      org.opencontainers.image.url="https://github.com/Fatalx26/networkplanner" \
      org.opencontainers.image.source="https://github.com/Fatalx26/networkplanner" \
      org.opencontainers.image.documentation="https://github.com/Fatalx26/networkplanner#readme"

WORKDIR /app

# Server first, then the static front-end files. There is no `npm install`
# because the server only uses Node's built-in modules.
COPY package.json server.js ./
COPY public ./public

# PORT     — port the server listens on inside the container
# DATA_DIR — where layout.json is written; mounted as a volume so it persists
ENV PORT=8080 \
    DATA_DIR=/data

# Create the data directory owned by the unprivileged "node" user, then
# declare it a volume so layouts survive container upgrades/re-creation.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Never run as root.
USER node

EXPOSE 8080

# Docker marks the container healthy once /healthz answers.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
