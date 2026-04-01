# --- Stage 1: Build ---
    FROM node:20-alpine AS builder
    WORKDIR /app
    
    COPY investlan.crt /etc/ssl/certs/investlan.crt
    ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/investlan.crt
    
    COPY package.json tsconfig.base.json ./
    COPY packages/ ./packages/
    COPY apps/agent_service/ ./apps/agent_service/
    # Migration 20240101000008 seeds agents from ../../../apps/coreInstructions.json → /app/apps/coreInstructions.json
    COPY apps/core_instructions/projectManager.json ./apps/core_instructions/projectManager.json
    
    RUN npm install --no-package-lock
    RUN npm run build --workspace=@scheduling-agent/types
    RUN npm run build --workspace=@scheduling-agent/database
    RUN npm run build --workspace=agent_service
    
    # --- Stage 2: Production ---
    FROM node:20-alpine AS runner
    WORKDIR /app
    
    COPY investlan.crt /etc/ssl/certs/investlan.crt
    ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/investlan.crt
    
    RUN apk add --no-cache python3 py3-pip git bash
    RUN pip3 install --break-system-packages uv 
    
    RUN npm install -g --unsafe-perm @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-bash @modelcontextprotocol/server-fetch @modelcontextprotocol/server-github
    
    COPY package.json ./
    COPY --from=builder /app/node_modules/ ./node_modules/
    COPY --from=builder /app/packages/ ./packages/
    COPY --from=builder /app/apps/agent_service/ ./apps/agent_service/
    
    RUN mkdir -p /app/data
    VOLUME ["/app/data"]
    
    ENV NODE_ENV=production
    ENV DATA_DIR=/app/data
    
    CMD ["npm", "start", "--workspace=agent_service"]