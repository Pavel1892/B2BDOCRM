# Sestavení z této složky:  docker build -t fve-hub .
FROM node:22-alpine
WORKDIR /app
COPY server.mjs package.json Schlieger-FVE-Hub.html ./
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "server.mjs"]
