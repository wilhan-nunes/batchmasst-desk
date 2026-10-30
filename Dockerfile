FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --chown=node:node lib ./lib
COPY --chown=node:node templates ./templates
COPY --chown=node:node server.mjs ./
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.mjs"]
