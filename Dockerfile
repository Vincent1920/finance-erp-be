FROM oven/bun:1.3-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS runtime

WORKDIR /app
ENV APP_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY app.ts index.ts ./
COPY config ./config
COPY constants ./constants
COPY controllers ./controllers
COPY database ./database
COPY middleware ./middleware
COPY repositories ./repositories
COPY routes ./routes
COPY services ./services
COPY types ./types
COPY utils ./utils
COPY validators ./validators

USER bun
EXPOSE 8000

CMD ["bun", "run", "start"]
