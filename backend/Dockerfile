# Build stage
FROM node:20-alpine AS builder

# Bun does the installs and builds (bun.lock); Node only runs the app.
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY . .
RUN bun run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache ffmpeg

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 -G nodejs

# Bun installs the production deps (bun.lock), the same way the builder does.
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun

# Copy package files and install production deps only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && bun pm cache rm

# Copy built app from builder
COPY --from=builder /app/dist ./dist

# Create uploads directory (used by ServeStaticModule)
RUN mkdir -p uploads && chown -R nestjs:nodejs . uploads

USER nestjs

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "dist/src/main.js"]
