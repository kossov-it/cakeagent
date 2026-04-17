# CakeAgent

## Purpose
Minimal, secure personal AI assistant built on the Claude Agent SDK. Connects to Telegram, runs agents via `query()`, manages integrations via MCP + skills.sh, supports voice.

## Tech Stack
- **Runtime**: Node.js 18+ (ESM)
- **Agent**: `@anthropic-ai/claude-agent-sdk` — `query()`, `createSdkMcpServer`, `tool()`, hooks
- **Storage**: `better-sqlite3` (SQLite with WAL mode)
- **Validation**: `zod` (v4, peer dep of Agent SDK)
- **Telegram**: Raw `fetch()` — no framework, 0 deps
- **Voice (optional)**: `edge-tts` for TTS, local `whisper-cli` for STT — no API keys

## Directory Layout
```
src/index.ts        — Orchestrator: poll loop, routing, debounce, cron scheduler, memory extraction, .env loading, system tasks, shutdown
src/agent.ts        — Agent SDK wrapper: query(), session resume, streaming
src/tools.ts        — In-process MCP server: 22 tools (schedule/skills/MCP/memory/search/audit)
src/cron.ts         — 5-field cron parser + @nicknames + cronToHuman()
src/hooks.ts        — Security hooks: 5 PreToolUse matchers (85+ bash deny patterns) + SubagentStart + PreCompact
src/store.ts        — SQLite CRUD (messages, schedules, groups, sessions, audit, skills)
src/voice.ts        — STT (whisper-cli) + TTS (edge-tts)
src/types.ts        — Shared types + validation constants
channels/telegram.ts — Raw fetch Telegram adapter (retry, HTML, chunking)
groups/main/CLAUDE.md — Agent identity + rules (not this file)
data/skills/        — Installed skill content (.md) + index.json
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
- Two integration paths: MCP servers (runtime tools) and skills.sh (CLI-based, knowledge-driven)
- Skills stored in `data/skills/`, loaded into prompt as `[SKILLS]` block
- `acceptEdits` permission mode — never `bypassPermissions`
- CLAUDE.md in `groups/*/` is read-only for the agent — memory goes to `data/memory.md`
- Sequential processing — one agent invocation at a time
- Settings hot-reloaded from `data/settings.json` per invocation
- Cron scheduling via `src/cron.ts` — 5-field cron expressions
- System tasks (morning check-in, dream) created on first boot via `ensureSystemTasks()` in index.ts
- Auto memory extraction runs every N conversations — silent background agent call
- Missed scheduled tasks recovered on startup (one-shot fire, recurring advance)
- Task queue prevents dropped tasks when agent is busy

## Security
- Dedicated `cakeagent` system user with nologin shell
- systemd: `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`
- Sudoers whitelist: `apt-get`, `apt`, `dpkg`, `systemctl`, `nft`, `iptables`, `ip6tables`, `bash setup.sh *`
- systemd `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK` — NETLINK required so sudo-allowed `nft`/`iptables` can speak to the kernel
- `setup.sh install-config <path>` writes validated config files to `/etc/` (nginx, systemd units, sysctl.d, apt sources.list.d, logrotate.d, nftables.conf, etc.) without giving sudo `tee`/`cp` (sudoers wildcards in args allow path traversal, so `/usr/bin/tee /etc/nginx/*` is unsafe). Critical files (sudoers, shadow, ssh, pam.d, cron.d, ld.so.preload, hosts, resolv.conf, fstab, cakeagent.service) are hard-denied in the helper *and* the bash/Write hooks
- 5 PreToolUse hooks: Bash (85+ deny patterns + quote-stripped normalization), Read, Grep, Glob, Write/Edit
- Symlink-aware path checks via `realpathSync` (defeats `/tmp` symlink bypass)
- SSRF guard on outbound fetch (`install_skill`, registry) — rejects private/loopback/metadata
- SubagentStart hook logs all subagent launches to audit_log
- PreCompact hook archives conversations on context compaction
- Bash commands normalized (quotes stripped) before deny-pattern matching
- Settings validated: model, thinkingLevel, voiceTtsVoice checked against allowed values
- Skill content capped at 50 KB, memory.md capped at 50 KB
- Atomic writes for settings.json and skills/index.json (write-tmp-then-rename)
- Prompt injection detection: flagged messages get security warning prepended
- Memory/skill content sanitized via `sanitizeMemory()` before storage
- Rate limiting persisted in SQLite; all tool calls logged to audit_log
- Chat ID + sender allowlist — only configured Telegram chats and senders processed
- Concurrency guard (`agentBusy`) — one agent invocation at a time
- `.env` permission check on startup (warns if not 600)
- `unhandledRejection` handler with audit logging
