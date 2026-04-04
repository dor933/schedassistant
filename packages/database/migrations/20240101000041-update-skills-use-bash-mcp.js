"use strict";

/**
 * Adds new skill rows that instruct agents to use the **bash** MCP for
 * Docker and HTTP instead of the limited single-purpose MCP servers.
 * Also adds an improved massive_market_data skill that tells the agent
 * to explore the 40+ tools before calling them.
 *
 * The old skills (dev-docker-mcp, dev-fetch-mcp, dev-massive-market-mcp)
 * are left in place — remove them manually once agents are migrated.
 *
 * Idempotent: INSERT … WHERE NOT EXISTS on `slug`.
 *
 * @type {import('sequelize-cli').Migration}
 */

/** @type {{ slug: string; name: string; description: string; skillText: string }[]} */
const SKILLS = [
  {
    slug: "bash-docker-cli",
    name: "Docker CLI (bash MCP)",
    description: "Manage Docker containers, images, volumes, and networks via the bash MCP shell.",
    skillText: `# Docker — bash MCP (\`mcp-shell\`)

## Server
- **bash** (DB name) — \`npx -y mcp-shell\`

## Scope
Full **docker CLI** access: containers, images, volumes, networks, compose, and diagnostics.

## Recommended commands

### Containers
- \`docker ps\` / \`docker ps -a\` — list running / all containers
- \`docker logs <container> --tail 100\` — recent logs
- \`docker logs <container> -f --since 5m\` — follow logs from the last 5 minutes
- \`docker inspect <container>\` — full container details (networking, mounts, env)
- \`docker exec -it <container> <cmd>\` — run a command inside a running container
- \`docker stop <container>\` / \`docker start <container>\` / \`docker restart <container>\`
- \`docker rm <container>\` — remove a stopped container
- \`docker stats --no-stream\` — one-shot resource usage for all running containers

### Images
- \`docker images\` — list local images
- \`docker pull <image>\` — pull an image from registry
- \`docker build -t <tag> .\` — build an image from Dockerfile
- \`docker rmi <image>\` — remove an image
- \`docker image prune -f\` — remove dangling images

### Volumes & networks
- \`docker volume ls\` / \`docker volume inspect <vol>\`
- \`docker network ls\` / \`docker network inspect <net>\`

### Compose
- \`docker compose up -d\` / \`docker compose down\`
- \`docker compose ps\` — status of compose services
- \`docker compose logs <service> --tail 50\`
- \`docker compose build [service]\` — rebuild one or all services

### Diagnostics
- \`docker system df\` — disk usage summary
- \`docker system prune -f\` — reclaim space (stopped containers, unused images, build cache)
- \`docker events --since 10m\` — recent daemon events

## Rules
1. Only claim success after **real** tool output.
2. Report stderr / exit codes honestly.
3. Prefer \`--no-stream\` or \`--tail\` to avoid unbounded output.`,
  },
  {
    slug: "bash-http-requests",
    name: "HTTP requests (bash MCP)",
    description: "Perform HTTP requests (GET, POST, PUT, DELETE) via curl in the bash MCP shell.",
    skillText: `# HTTP requests — bash MCP (\`mcp-shell\`)

## Server
- **bash** (DB name) — \`npx -y mcp-shell\`

## Scope
Full **curl** / **wget** access for any HTTP method: GET, POST, PUT, PATCH, DELETE.

## Recommended commands

### Basic requests
- \`curl -s <url>\` — silent GET
- \`curl -sS -o /dev/null -w "%{http_code}" <url>\` — status code only
- \`curl -sS -D - <url>\` — response with headers
- \`curl -sS <url> | jq .\` — pretty-print JSON response

### Sending data
- \`curl -X POST -H "Content-Type: application/json" -d '{"key":"value"}' <url>\`
- \`curl -X PUT -H "Content-Type: application/json" -d @payload.json <url>\`
- \`curl -X PATCH -H "Content-Type: application/json" -d '{"field":"new"}' <url>\`
- \`curl -X DELETE <url>\`

### Authentication
- \`curl -H "Authorization: Bearer $TOKEN" <url>\`
- \`curl -u user:pass <url>\` — basic auth

### Downloads
- \`curl -LO <url>\` — download file, follow redirects
- \`wget -q <url> -O output.txt\` — download to specific file

### Debugging
- \`curl -v <url>\` — verbose (TLS, headers, timing)
- \`curl -w "\\ntime_total: %{time_total}s\\n" -sS <url>\` — measure request time

## Rules
1. Only claim success after **real** tool output.
2. Use \`-sS\` (silent but show errors) as default.
3. Pipe through \`jq\` when the response is JSON for readability.
4. Never print secrets or tokens in output.
5. For large responses, use \`| head -c 5000\` or \`jq 'keys'\` to keep output manageable.

## Not for
- GitHub REST API → \`mcp-github-api\` (uses PAT automatically).`,
  },
  {
    slug: "mcp-massive-market-data",
    name: "Market data (massive_market_data MCP)",
    description: "Massive market data via the massive_market_data MCP server — 4 tools: search_endpoints, get_endpoint_docs, call_api, query_data.",
    skillText: `# Market data — massive_market_data MCP (v0.8.3)

## Server
- **massive_market_data** — \`MASSIVE_API_KEY\` via env merge.

## Architecture (v0.8.0+)
The server exposes **4 tools** (down from 53 in v0.7.x). At startup it fetches the \`llms.txt\` documentation index from Massive and builds a BM25 search index so new endpoints are discoverable without updating the server.

## Tools

### 1. \`search_endpoints\`
Search for API endpoints and built-in financial functions by natural-language query.
- **query** (string) — what you are looking for
- **scope** (enum, optional) — \`endpoints\`, \`functions\`, or \`both\` (default)

### 2. \`get_endpoint_docs\`
Fetch full parameter documentation for a specific endpoint (path params, query params, types, defaults, constraints).
- **url** (string) — the endpoint URL from search results

### 3. \`call_api\`
Call any Massive REST API endpoint.
- **method** (string) — HTTP method
- **path** (string) — API path
- **params** (object) — query/body params
- **store_as** (string, optional) — save response as an in-memory DataFrame for later SQL queries
- **apply** (string, optional) — run built-in financial functions inline (e.g. \`"sma(close, 20)"\`)

### 4. \`query_data\`
Run SQL against stored DataFrames (embedded SQLite). Supports JOINs, CTEs, window functions, aggregations.
- **sql** (string) — the query (\`SHOW TABLES\`, \`DESCRIBE <table>\`, \`DROP TABLE\` also work)
- **apply** (string, optional) — financial function to apply to results

## Built-in financial functions (use via \`apply\` parameter)
- **Options Greeks (Black-Scholes):** \`bs_price\`, \`bs_delta\`, \`bs_gamma\`, \`bs_theta\`, \`bs_vega\`, \`bs_rho\`
- **Returns analysis:** \`simple_return\`, \`log_return\`, \`cumulative_return\`, \`sharpe_ratio\`, \`sortino_ratio\`
- **Technical indicators:** \`sma\`, \`ema\`

## Workflow
1. **Search** — use \`search_endpoints\` to find the right API endpoint for the task.
2. **Read docs** — use \`get_endpoint_docs\` to understand parameters.
3. **Call** — use \`call_api\` with \`store_as\` to fetch and store data.
4. **Analyze** — use \`query_data\` with SQL and \`apply\` for calculations.

## Rules
1. Only claim success after **real** tool output.
2. Never hardcode API keys or print \`MASSIVE_API_KEY\`.
3. Always start with \`search_endpoints\` — do not guess tool names or endpoints.
4. For large result sets, ask the user if they want a summary or the full data.
5. If a tool returns an error, report it honestly — do not fabricate data.`,
  },
];

async function insertSkill(queryInterface, { slug, name, description, skillText }) {
  await queryInterface.sequelize.query(
    `INSERT INTO skills (name, slug, description, skill_text, created_at, updated_at)
     SELECT :name, :slug, :description, :skillText, NOW(), NOW()
     WHERE NOT EXISTS (SELECT 1 FROM skills WHERE slug = :slug)`,
    {
      replacements: { name, slug, description, skillText },
    },
  );
}

module.exports = {
  async up(queryInterface, _Sequelize) {
    for (const skill of SKILLS) {
      await insertSkill(queryInterface, skill);
    }
  },

  async down(queryInterface, _Sequelize) {
    for (const { slug } of [...SKILLS].reverse()) {
      await queryInterface.sequelize.query(`DELETE FROM skills WHERE slug = :slug`, {
        replacements: { slug },
      });
    }
  },
};
