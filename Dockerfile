FROM node:22-alpine

# docker-cli: lets the server talk to the host Docker through the mounted socket
# bash: the shell used to run commands
RUN apk add --no-cache docker-cli bash

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
