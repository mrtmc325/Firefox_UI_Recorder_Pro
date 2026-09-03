# License server image. Before deploying: `docker pull node:24-alpine`, pin the digest here
# (FROM node:24-alpine@sha256:...), and run `trivy image` / `grype` on the built image.
FROM node:24-alpine
RUN addgroup -S uir && adduser -S -G uir uir && mkdir -p /data && chown uir:uir /data
WORKDIR /app
COPY --chown=uir:uir server.mjs db.mjs preamble.mjs token.mjs cli.mjs ./
USER uir
ENV LICENSE_DB_PATH=/data/license.db LICENSE_PORT=8443 LICENSE_BIND=0.0.0.0 NODE_ENV=production
# 8443 = public API. If LICENSE_ADMIN_PORT is set, publish it ONLY to the host loopback (see compose).
EXPOSE 8443
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD node -e "require('node:net').connect(process.env.LICENSE_PORT,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))"
CMD ["node", "server.mjs"]
