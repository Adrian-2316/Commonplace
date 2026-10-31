# Commonplace: one image with the API, the collaboration server and the built web app.

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS server
WORKDIR /server
COPY server/package.json server/package-lock.json server/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production WEB_DIR=/app/web PORT=3000
WORKDIR /app
COPY --from=server /server/node_modules ./node_modules
COPY --from=server /server/dist ./dist
COPY --from=server /server/package.json ./
COPY --from=web /web/dist ./web
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/main.js"]
