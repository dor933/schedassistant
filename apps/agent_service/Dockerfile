# --- Stage 1: Build ---
    FROM node:22-alpine AS builder
    WORKDIR /app
    
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
    FROM node:22-alpine AS runner
    WORKDIR /app
    
    RUN apk add --no-cache python3 py3-pip git bash curl wget libsodium-dev gcc musl-dev python3-dev su-exec github-cli
    RUN pip3 install --break-system-packages uv pynacl

    RUN npm install -g --unsafe-perm @modelcontextprotocol/server-filesystem mcp-shell @modelcontextprotocol/server-github @alisaitteke/docker-mcp @anthropic-ai/claude-code
    COPY package.json ./
    COPY --from=builder /app/node_modules/ ./node_modules/
    COPY --from=builder /app/packages/ ./packages/
    COPY --from=builder /app/apps/agent_service/ ./apps/agent_service/
    
    # Non-root user for claude CLI only (--dangerously-skip-permissions rejects root)
    RUN addgroup -S agent && adduser -S agent -G agent
    RUN su-exec agent git config --global user.email "agent@sched-assist.dev" && \
        su-exec agent git config --global user.name "Sched Assist Agent" && \
        su-exec agent git config --global safe.directory '*'

    RUN git config --global user.email "agent@sched-assist.dev" && \
        git config --global user.name "Sched Assist Agent" && \
        git config --global safe.directory '*'
    RUN mkdir -p /app/data
    # Pre-create the Claude CLI home directory with agent ownership so that when
    # Docker initializes the `agent_claude_home` named volume on first mount, it
    # inherits agent:agent ownership from the image. Without this, the fresh
    # volume would come up root-owned and the CLI (which runs as `agent`) would
    # fail to write session files. This works because Docker copies ownership
    # from the image directory into a fresh named volume on first creation.
    RUN mkdir -p /home/agent/.claude && chown -R agent:agent /home/agent
    VOLUME ["/app/data"]

    ENV NODE_ENV=production
    ENV DATA_DIR=/app/data

    CMD ["npm", "start", "--workspace=agent_service"]