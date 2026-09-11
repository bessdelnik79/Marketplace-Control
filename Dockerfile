FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY app ./app
COPY db/migrations ./db/migrations
EXPOSE 3000
CMD ["node", "app/server.mjs"]
