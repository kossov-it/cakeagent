# CakeAgent

## Purpose
Minimal, secure personal AI assistant built on the Claude Agent SDK. Connects to Telegram, runs agents via `query()`, manages tools via MCP, supports voice.

## Tech Stack
- **Runtime**: Node.js 18+ (ESM)
- **Agent**: `@anthropic-ai/claude-agent-sdk` — `query()`, `createSdkMcpServer`, `tool()`, hooks
- **Storage**: `better-sqlite3` (SQLite with WAL mode)
- **Validation**: `zod` (v4, peer dep of Agent SDK)
- **Telegram**: Raw `fetch()` — no framework, 0 deps
- **Voice (optional)**: `edge-tts` for TTS, local `whisper-cli` for STT — no API keys

## Directory Layout
```
src/index.ts        — Orchestrator: poll loop, routing, scheduler, shutdown
src/agent.ts        — Agent SDK wrapper: query(), session resume
src/tools.ts        — In-process MCP server (createSdkMcpServer)
src/hooks.ts        — Security hooks: bash validator, memory guard, interceptor
src/store.ts        — SQLite CRUD (messages, schedules, groups, sessions, audit)
src/voice.ts        — STT + TTS providers
src/config.ts       — .env loading
src/types.ts        — Shared types
channels/telegram.ts — Raw fetch Telegram adapter
groups/main/CLAUDE.md — Agent identity + rules (not this file)
```

## Build / Run / Test
```bash
npm install          # Install dependencies
npm run dev          # Development (tsx)
npm run build        # Compile TypeScript
npm start            # Production (node dist/)
npx tsc --noEmit     # Type-check only
```

## Key Conventions
- ESM only (`"type": "module"`) — use `.js` extensions in imports
- No framework dependencies for HTTP — raw `fetch()` everywhere
- In-process MCP server via `createSdkMcpServer` — no child process IPC
- PostToolUse hooks intercept MCP tool calls via closure-shared state
- `acceptEdits` permission mode — never `bypassPermissions`
- CLAUDE.md in `groups/*/` is read-only for the agent — memory goes to `data/memory.md`
- Sequential processing — one agent invocation at a time
- Settings hot-reloaded from `data/settings.json` per invocation

## Security
- Dedicated `cakeagent` system user with nologin shell
- systemd: `ProtectSystem=full`, `ProtectHome=true`, `PrivateTmp=true`
- Passwordless sudo limited to `/usr/bin/apt-get` and `/usr/bin/apt` only
- Bash commands validated by PreToolUse hook (deny injection patterns)
- Write/Edit to CLAUDE.md, .env, credentials/ blocked by PreToolUse hook
- Rate limiting persisted in SQLite
- All tool calls logged to audit_log table
- Chat ID + sender allowlist — only configured Telegram chats and senders processed
- Concurrency guard (`agentBusy`) — one agent invocation at a time
- Memory injection — memory.md prepended to every prompt, not relying on agent file reads
- Streaming responses — assistant text sent immediately, final result deduped
