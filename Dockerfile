# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app
ENV CI=true
# Enable corepack to use pnpm
RUN corepack enable

# Install dependencies using lockfile
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./tsconfig.json
COPY src ./src
RUN pnpm build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

# Install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Copy built artifacts
COPY --from=builder /app/dist ./dist

# Default port env; compose will map as needed
ENV WS_PORT=8080
EXPOSE 8080 8081

# Start the server
CMD ["node", "dist/index.js"]

