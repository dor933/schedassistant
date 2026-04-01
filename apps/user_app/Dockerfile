# --- Stage 1: Build server + client ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/user_app/ ./apps/user_app/
# auth.service reads ../../../coreInstructions.json from dist → /app/apps/coreInstructions.json
COPY apps/core_instructions/projectManager.json ./apps/core_instructions/projectManager.json

RUN npm install --no-package-lock

RUN npm run build --workspace=@scheduling-agent/types
RUN npm run build --workspace=@scheduling-agent/database
RUN npm run build --workspace=user_app

RUN cd apps/user_app/client && npm install --no-package-lock && npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS runner
WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/packages/ ./packages/
COPY --from=builder /app/apps/user_app/dist/ ./apps/user_app/dist/
COPY --from=builder /app/apps/user_app/package.json ./apps/user_app/
COPY --from=builder /app/apps/user_app/client/dist/ ./apps/user_app/client/dist/
COPY --from=builder /app/apps/core_instructions/projectManager.json ./apps/core_instructions/projectManager.json

ENV NODE_ENV=production

CMD ["npm", "start", "--workspace=user_app"]
