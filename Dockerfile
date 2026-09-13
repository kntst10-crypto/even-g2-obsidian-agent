FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node src ./src
USER node
ENV PORT=8790
EXPOSE 8790
CMD ["node", "src/relay.mjs"]
