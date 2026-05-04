# --- Stage 1: Build ---
    FROM node:22-alpine AS builder
    WORKDIR /app
    
    COPY package.json tsconfig.base.json ./
    COPY packages/ ./packages/
    COPY apps/agent_service/ ./apps/agent_service/

    RUN npm install --no-package-lock
    RUN npm run build --workspace=@scheduling-agent/types
    RUN npm run build --workspace=@scheduling-agent/database
    RUN npm run build --workspace=agent_service

    # TypeScript compiles only .ts → dist/. The askGrahamy v6 Research Object
    # SQL files are loaded at runtime from `__dirname/queries`, while PG-native
    # capability SQL files are loaded from `__dirname/pgCapabilities/queries`.
    # Copy both runtime asset folders into dist.
    RUN cp -r apps/agent_service/src/askGrahamy/queries \
              apps/agent_service/dist/askGrahamy/queries
    RUN cp -r apps/agent_service/src/askGrahamy/pgCapabilities/queries \
              apps/agent_service/dist/askGrahamy/pgCapabilities/queries
    
    # --- Stage 2: Production ---
    FROM node:22-alpine AS runner
    WORKDIR /app
    
    RUN apk add --no-cache python3 py3-pip git bash curl wget libsodium-dev gcc musl-dev python3-dev su-exec github-cli docker-cli
    RUN pip3 install --break-system-packages uv pynacl

    # @openai/codex installs the `codex` binary used by the run_codex_cli tool
    # and the codex-backed paths in cliExecution.ts. Same global-npm style as
    # claude-code so both CLIs end up on PATH for the `agent` user.
    #
    # Note: `mcp-shell` was previously installed here as the bash MCP server.
    # It was removed once agents migrated to the Claude Agent SDK's native
    # `Bash` tool (gated per-agent by `agents.allow_sdk_bash`). DB rows in
    # `mcp_servers` and `agent_available_mcp_servers` referencing the legacy
    # `bash` MCP can be cleaned up via the admin UI as agents are migrated.
    RUN npm install -g --unsafe-perm @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-github @alisaitteke/docker-mcp @anthropic-ai/claude-code @openai/codex
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
    RUN mkdir -p /app/data /app/data/library
    # Pre-create the Claude CLI home directory with agent ownership so that when
    # Docker initializes the `agent_claude_home` named volume on first mount, it
    # inherits agent:agent ownership from the image. Without this, the fresh
    # volume would come up root-owned and the CLI (which runs as `agent`) would
    # fail to write session files. This works because Docker copies ownership
    # from the image directory into a fresh named volume on first creation.
    RUN mkdir -p /home/agent/.claude/agents
    COPY apps/agent_service/claude-config/ /home/agent/.claude/
    # Pre-create /home/agent/.codex with agent ownership so the same
    # named-volume-on-first-mount trick that protects /home/agent/.claude
    # also gives codex a writable home for its session cache + auth.json.
    # The codexAuthJson admin endpoint also chowns this dir at write time;
    # creating it here means codex's first spawn doesn't have to.
    RUN mkdir -p /home/agent/.codex
    RUN chown -R agent:agent /home/agent
    VOLUME ["/app/data"]

    ENV NODE_ENV=production
    ENV DATA_DIR=/app/data

    CMD ["npm", "start", "--workspace=agent_service"]
