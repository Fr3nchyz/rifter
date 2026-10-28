# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.3
WORKDIR /app
# .dockerignore excludes credentials, databases, caches and generated artifacts.
# One source layer also avoids large intermediate snapshots on vfs builders.
COPY . /app
RUN --mount=type=secret,id=proxy_ca,target=/run/secrets/proxy_ca,required=false \
    set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates python3 tini; \
    rm -rf /var/lib/apt/lists/*; \
    if [ -s /run/secrets/proxy_ca ]; then \
      export SSL_CERT_FILE=/run/secrets/proxy_ca NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    cd /app/upstream/openrift; \
    bun install --frozen-lockfile --production --ignore-scripts --filter=api; \
    cd /app; \
    python3 scripts/apply-openrift.py --api-only; \
    bun pm cache rm
ENV RIFTER_ROOT=/app APP_ENV=production
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["python3", "/app/deploy/railway/start.py"]
