# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NanoClaw is a personal Claude assistant that runs Claude Code in isolated containers. It supports multiple messaging channels (QQ, WhatsApp, Telegram, Slack, Discord, web) and provides secure, per-group isolation with persistent sessions.

## Commands

```bash
npm run build        # Compile TypeScript to dist/
npm run dev          # Run development server with tsx
npm start            # Run compiled server
npm test             # Run all tests with vitest
npm run test:watch   # Run tests in watch mode
npm run typecheck    # Type check without emitting
npm run format       # Format with prettier
```

## Architecture

### Host Side (`src/`)

- **`index.ts`** - Main entry point; message loop, channel connection, state management
- **`container-runner.ts`** - Spawns containers, handles IPC, mounts volumes
- **`container-runtime.ts`** - Abstraction over Docker/Podman
- **`db.ts`** - SQLite database for messages, sessions, groups, scheduled tasks
- **`group-queue.ts`** - Per-group message queuing with concurrency limits
- **`channels/`** - Pluggable channel implementations (QQ, WhatsApp, Telegram, etc.)
- **`ipc.ts`** - File-based IPC for container→host communication
- **`task-scheduler.ts`** - Cron/interval task scheduling

### Container Side (`container/`)

- **`agent-runner/`** - Runs inside container, uses Claude Agent SDK
- **`skills/`** - MCP tools available to agents (agent-browser, camera, etc.)
- **`Dockerfile`** - Container image with Node.js, Chromium, Claude Code

### Key Directories

- **`groups/`** - Per-group folders with CLAUDE.md memory and logs
- **`groups/global/CLAUDE.md`** - Shared memory for all groups
- **`groups/main/`** - Main control group with elevated privileges
- **`data/`** - Sessions, IPC files
- **`store/`** - SQLite database

### Configuration Files

- **`.env`** - Secrets (ANTHROPIC_AUTH_TOKEN, channel credentials). Never mounted into containers.
- **`.env_container`** - Environment variables passed to containers
- **`~/.config/nanoclaw/mount-allowlist.json`** - Security allowlist for additional mounts
- **`~/.config/nanoclaw/sender-allowlist.json`** - Per-chat sender restrictions

## Key Concepts

### Channels

Channels are messaging platform adapters. Each channel:
1. Implements the `Channel` interface (`src/types.ts`)
2. Self-registers via `registerChannel()` in `src/channels/index.ts`
3. Is created by a factory function that returns `null` if credentials are missing

### Groups

Groups are registered chat sessions with:
- Isolated container sessions (`.claude/` stored per-group in `data/sessions/`)
- Their own folder under `groups/` for memory and logs
- Optional additional mounts via `containerConfig.additionalMounts`
- Trigger requirements (main group has no trigger; others need `@AssistantName`)

### Container Execution

1. Host writes `ContainerInput` JSON to container's stdin
2. Container runs Claude Agent SDK with the prompt
3. Results streamed back via stdout with `---NANOCLAW_OUTPUT_START/END---` markers
4. Follow-up messages via IPC files in `/workspace/ipc/input/`

### Security

- `.env` is never mounted into containers; secrets passed via stdin
- Main group gets project root read-only; other groups only see their folder
- Additional mounts validated against `mount-allowlist.json`
- Non-root user inside container

## Building the Container

```bash
cd container && ./build.sh [tag]
```

The container image (`nanoclaw-agent:latest`) must be built before running the server.

## Testing

Tests are located next to source files with `.test.ts` suffix. Run specific tests:

```bash
npx vitest run src/db.test.ts
```
