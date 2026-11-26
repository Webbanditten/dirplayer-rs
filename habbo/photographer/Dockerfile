# Room photographer. Build context: dirplayer-rs/habbo (it runs ../dev-server.cjs, the DirPlayer harness).
#   docker build -f photographer/Dockerfile -t room-photographer .
FROM node:22-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production
WORKDIR /app

COPY photographer/package.json photographer/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY dev-server.cjs ./dev-server.cjs
COPY photographer/server.cjs ./photographer/server.cjs

USER node
EXPOSE 8095
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8095) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "photographer/server.cjs"]
