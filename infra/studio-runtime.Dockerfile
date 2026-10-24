FROM node:24.17.0-alpine@sha256:156b55f92e98ccd5ef49578a8cea0df4679826564bad1c9d4ef04462b9f0ded6
WORKDIR /app
COPY --chown=node:node . /app
USER node
ENV NODE_ENV=production PORT=8080 STUDIO_BIND_HOST=0.0.0.0 STUDIO_RUNTIME_MANIFEST=/app/manifest.json
EXPOSE 8080
CMD ["node", "server.mjs"]
