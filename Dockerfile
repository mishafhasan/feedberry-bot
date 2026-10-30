# Node 24 is required by src/db/index.ts (node:sqlite); Node 22 would need --experimental-sqlite.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY cobalt-engine ./cobalt-engine
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
# ffmpeg serves cobalt's YouTube muxing and the 1-second thumbnail frame (§8.6).
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    DB_PATH=/data/bot.db
COPY package*.json ./
COPY cobalt-engine ./cobalt-engine
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
VOLUME /data
# Opening the database proves the file is there and not left locked by a dead writer.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD node -e "const{DatabaseSync}=require('node:sqlite');new DatabaseSync(process.env.DB_PATH||'/data/bot.db').close()" || exit 1
CMD ["node", "dist/main.js"]
