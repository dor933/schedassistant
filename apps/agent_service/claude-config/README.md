# Claude CLI seed config

This directory is `COPY`ed into `/home/agent/.claude/` during Docker build
(see `apps/agent_service/Dockerfile:54`).

Anything placed here is pre-baked into the image and visible to the
`claude` CLI when it runs as the `agent` user. The directory's existence
is also load-bearing: it ensures `/home/agent/.claude/` is created with
`agent:agent` ownership in the image, so when the `agent_claude_home`
Docker named volume mounts on first run it inherits that ownership rather
than coming up `root`-owned (which would break the CLI's ability to write
session files).

## What you can put here

- `agents/*.md` — Claude Code sub-agent definitions (frontmatter +
  prompt body). Read by the CLI's Task tool / sub-agent system.
- `settings.json` — CLI settings (permissions allowlist, model defaults,
  etc.). Per-deployment baseline; users can still override per session.
- `commands/*.md` — Custom slash commands available to the CLI.
- Other CLI-recognised config files (see Claude Code docs).

## Empty is fine

Today this directory only contains this README. The `COPY` succeeds
either way; if you don't have any config to seed, leave it as-is. The
directory itself is the point.

## Why this exists in git

Without it the Docker build fails at the `COPY` step because BuildKit
can't checksum a non-existent path. Committing an empty directory (with
this README acting as the keep-file) guarantees the build succeeds on
any clean checkout.
