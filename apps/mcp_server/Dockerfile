# --- Stage 1: Build ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/mcp_server/ ./apps/mcp_server/

RUN npm install --no-package-lock
RUN npm run build --workspace=@scheduling-agent/types
RUN npm run build --workspace=@scheduling-agent/database
RUN npm run build --workspace=mcp_server

# --- Stage 2: Production ---
FROM node:20-alpine AS runner
WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/mcp_server/ ./apps/mcp_server/

ENV NODE_ENV=production

CMD ["npm", "start", "--workspace=mcp_server"]
