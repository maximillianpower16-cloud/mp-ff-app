# Avalon has no dependencies and no build step, so this is about as small as a
# Node image gets. Rooms are kept in memory with a snapshot at /data — mount a
# volume there if you want games to survive a redeploy.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    AVALON_STATE=/data/rooms.json

WORKDIR /app
COPY package.json ./
COPY server.js game.js ./
COPY public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
