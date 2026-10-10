# Hosted TKBK MCP (mcp.tkbk.online): Streamable HTTP on 8787, stateless, settings from the environment.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# git sha of the deployed code; `docker inspect` shows what is running
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA
CMD ["node", "src/cli.mjs", "http"]
