# Carrier Management Hub — reproducible container build.
#
# The database is a file, so it MUST live on a mounted volume at /data. Without one,
# every carrier record is lost the moment the container restarts.
#
#   docker build -t carrier-hub .
#   docker volume create carrier-hub-data
#   docker run -d --name carrier-hub -p 3000:3000 \
#     -v carrier-hub-data:/data \
#     -e ADMIN_EMAIL=you@company.com -e ADMIN_PASSWORD='a real password' \
#     carrier-hub
#
# Self-serve signup is OFF unless you turn it on. A single-company install should leave it
# off — with it on, anyone who can reach this server can create an organisation on it:
#
#   -e SIGNUP_OPEN=1 \
#   -e APP_URL=https://hub.example.com \        # what goes in the emailed links
#   -e SMTP_URL=smtps://user:pass@smtp.example.com:465 \   # implicit TLS, port 465
#   -e MAIL_FROM='Carrier Hub <no-reply@example.com>'
#
# With SIGNUP_OPEN=1 and any of those three missing, the server refuses to serve rather
# than silently dropping confirmation mail (src/instrumentation.ts).

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── build ────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Build against a scratch database so the build never touches real data.
ENV CARRIER_DB_PATH=/tmp/build.db
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CARRIER_DB_PATH=/data/carrier-hub.db \
    BACKUP_DIR=/data/backups

RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs carrier

COPY --from=build /app/public ./public
COPY --from=build --chown=carrier:nodejs /app/.next/standalone ./
COPY --from=build --chown=carrier:nodejs /app/.next/static ./.next/static
# Kept so `npm run migrate` and `npm run backup` work inside the container.
COPY --from=build --chown=carrier:nodejs /app/src/lib ./src/lib
COPY --from=build --chown=carrier:nodejs /app/scripts ./scripts
# Next's standalone trace inlines `server-only`'s check into the compiled app and never
# treats the package itself as a runtime dependency, so it is missing from the pruned
# node_modules above. Any script that imports db.ts (which imports tenant-db.ts, which
# imports "server-only") needs the real package on disk — `--conditions=react-server`
# only makes it resolve to a no-op, it does not make Node able to find it at all.
COPY --from=build --chown=carrier:nodejs /app/node_modules/server-only ./node_modules/server-only

RUN mkdir -p /data && chown -R carrier:nodejs /data
VOLUME /data
USER carrier
EXPOSE 3000

# Migrations run before the server accepts traffic, so a half-upgraded schema is never
# served. They are idempotent, so restarts are free.
CMD ["sh", "-c", "node scripts/migrate.ts && node server.js"]

# $PORT, not 3000: a host like Railway or Fly injects its own port, and a healthcheck
# pointed at the wrong one reports a healthy server as dead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/login" >/dev/null 2>&1 || exit 1
