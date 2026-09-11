FROM postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
RUN apk add --no-cache nodejs npm curl && npm install --global pnpm@11.19.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY app ./app
COPY db/migrations ./db/migrations
COPY scripts/container-entrypoint.sh /usr/local/bin/marketplace-control-entrypoint
RUN chmod +x /usr/local/bin/marketplace-control-entrypoint
EXPOSE 3000 5432
ENTRYPOINT ["marketplace-control-entrypoint"]
