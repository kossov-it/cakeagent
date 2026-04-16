import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as store from './store.js';
import type { SharedState, CakeSettings } from './types.js';
import { DEFAULT_SETTINGS, VALID_MODELS, VALID_THINKING_LEVELS, VALID_TTS_VOICE_RE, sanitizeMemory } from './types.js';
import { parseCronExpression, computeNextCronRun, cronToHuman } from './cron.js';

const MCP_JSON_PATH = resolve('.mcp.json');
const ALLOWED_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'docker']);
const DANGEROUS_ARG_PATTERNS = [/--eval\b/, /-e(\s|$)/, /-c(\s|$)/, /\$\(/, /`/, /\|\s*(ba)?sh\b/, /;\s*rm/];

// Reject URLs targeting private / loopback / link-local / cloud-metadata
// endpoints so prompt-injected inputs can't turn our fetch() calls into an
// SSRF vector against the host. Only HTTPS is permitted for outbound content.
export function isSafeOutboundUrl(urlStr: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(urlStr); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https:// is permitted' };
  const host = u.hostname.toLowerCase();
  // Reject bare IPs and internal hostnames.
  const ipv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (ipv4) {
    const [a, b] = host.split('.').map(n => parseInt(n, 10));
    if (a === 10) return { ok: false, reason: 'private IPv4 (10/8)' };
    if (a === 127) return { ok: false, reason: 'loopback IPv4' };
    if (a === 169 && b === 254) return { ok: false, reason: 'link-local / cloud metadata' };
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return { ok: false, reason: 'private IPv4 (172.16/12)' };
    if (a === 192 && b === 168) return { ok: false, reason: 'private IPv4 (192.168/16)' };
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return { ok: false, reason: 'CGNAT range' };
    if (a === 0) return { ok: false, reason: 'reserved' };
  }
  if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'internal hostname' };
  }
  if (host.includes(':')) return { ok: false, reason: 'IPv6 literal — not allowed' };
  return { ok: true };
}

// Per-tool throttles. Keeps an agent stuck in a loop from blowing through
// install_tool / schedule_task / install_skill. Keys are namespaced so they
// don't collide with the per-sender message limiter.
function throttle(toolKey: string, max: number, windowMs: number): { ok: boolean; reason?: string } {
  if (!store.checkRateLimit(`tool:${toolKey}`, max, windowMs)) {
    store.logAudit('tool_rate_limited', toolKey);
    return { ok: false, reason: `Rate limit exceeded for ${toolKey} (${max} per ${Math.round(windowMs/1000)}s).` };
  }
  return { ok: true };
}

export function createTools(state: SharedState, dataDir: string, groupsDir: string) {
  return createSdkMcpServer({
    name: 'cakeagent',
    version: '0.1.0',
    tools: [

      tool(
        'send_message',
        'Send a message to the user immediately (for progress updates or multi-part responses)',
        { text: z.string().describe('Message text to send') },
        async (args) => {
          state.pendingMessages.push({ chatId: '', text: args.text });
          return { content: [{ type: 'text' as const, text: `Message queued: "${args.text.slice(0, 50)}..."` }] };
        },
      ),

      tool(
        'send_file',
        'Send a file back to the user (photos displayed inline, documents as attachments). Use after editing or generating a file.',
        {
          filePath: z.string().describe('Absolute path to the file to send'),
          caption: z.string().optional().describe('Optional caption for the file'),
        },
        async (args) => {
          if (!existsSync(args.filePath)) {
            return { content: [{ type: 'text' as const, text: `File not found: ${args.filePath}` }] };
          }
          state.pendingFiles.push({ chatId: '', filePath: args.filePath, caption: args.caption });
          return { content: [{ type: 'text' as const, text: `File queued: ${args.filePath}` }] };
        },
      ),

      tool(
        'schedule_task',
        'Create a scheduled or recurring task. Use cron for flexible schedules (e.g. "0 9 * * 1-5" = weekdays at 9am), interval for simple repeats, once for one-time reminders.',
        {
          task: z.string().describe('What the agent should do when the task fires'),
          scheduleType: z.enum(['interval', 'once', 'cron']).describe('Type: cron (5-field cron expression), interval (ms), once (one-time)'),
          scheduleValue: z.string().describe('Cron expression (e.g. "30 9 * * *"), interval in ms, or ISO timestamp for once'),
          nextRun: z.string().optional().describe('ISO 8601 timestamp of the next execution (auto-computed for cron)'),
          recurring: z.boolean().optional().describe('Whether the task repeats (default: true for cron/interval, false for once)'),
          contextMode: z.enum(['group', 'isolated']).default('isolated')
            .describe('group = run with chat history, isolated = fresh session'),
        },
        async (args) => {
          const th = throttle('schedule_task', 30, 60_000);
          if (!th.ok) return { content: [{ type: 'text' as const, text: th.reason! }] };
          let nextRun = args.nextRun ?? '';
          const recurring = args.recurring ?? (args.scheduleType !== 'once');

          if (args.scheduleType === 'cron') {
            const fields = parseCronExpression(args.scheduleValue);
            if (!fields) {
              return { content: [{ type: 'text' as const, text: `Invalid cron expression: "${args.scheduleValue}". Use 5-field format: minute hour day-of-month month day-of-week (e.g. "30 9 * * 1-5" for weekdays at 9:30am).` }] };
            }
            if (!nextRun) {
              const next = computeNextCronRun(fields, new Date());
              nextRun = next ? next.toISOString() : new Date(Date.now() + 60_000).toISOString();
            }
          }

          if (!nextRun) {
            return { content: [{ type: 'text' as const, text: 'nextRun is required for interval and once schedule types.' }] };
          }

          state.pendingSchedules.push({
            action: 'create',
            task: {
              groupFolder: '',
              chatId: '',
              task: args.task,
              scheduleType: args.scheduleType,
              scheduleValue: args.scheduleValue,
              contextMode: args.contextMode,
              nextRun,
              recurring,
              system: false,
              status: 'active',
            },
          });
          const display = args.scheduleType === 'cron' ? cronToHuman(args.scheduleValue) : args.scheduleValue;
          return { content: [{ type: 'text' as const, text: `Task scheduled: "${args.task.slice(0, 80)}" — ${display} — next run: ${nextRun}` }] };
        },
      ),

      tool(
        'list_schedules',
        'List all scheduled tasks',
        {},
        async () => {
          const tasks = store.getAllSchedules();
          if (tasks.length === 0) return { content: [{ type: 'text' as const, text: 'No scheduled tasks.' }] };
          const list = tasks.map(t => {
            const schedule = t.scheduleType === 'cron' ? cronToHuman(t.scheduleValue) : `${t.scheduleType}: ${t.scheduleValue}`;
            const flags = [t.system ? 'system' : '', t.recurring ? 'recurring' : 'one-shot'].filter(Boolean).join(', ');
            return `#${t.id} [${t.status}] ${t.task} (${schedule}, ${flags}, next: ${t.nextRun})`;
          }).join('\n');
          return { content: [{ type: 'text' as const, text: list }] };
        },
      ),

      tool(
        'delete_schedule',
        'Delete a scheduled task by ID. System tasks (morning check-in, dream) cannot be deleted — disable them via update_settings instead.',
        { id: z.number().describe('Schedule ID to delete') },
        async (args) => {
          const tasks = store.getAllSchedules();
          const task = tasks.find(t => t.id === args.id);
          if (task?.system) {
            return { content: [{ type: 'text' as const, text: `Cannot delete system task #${args.id} ("${task.task.slice(0, 40)}"). To disable it, use update_settings to set its cron to an empty string (e.g. morningCheckinCron="" or dreamCron="").` }] };
          }
          store.deleteSchedule(args.id);
          return { content: [{ type: 'text' as const, text: `Deleted schedule #${args.id}` }] };
        },
      ),

      tool(
        'update_schedule',
        'Modify a scheduled task',
        {
          id: z.number().describe('Schedule ID'),
          task: z.string().optional().describe('New task description'),
          scheduleValue: z.string().optional().describe('New schedule expression'),
          nextRun: z.string().optional().describe('New next run timestamp'),
          status: z.enum(['active', 'paused']).optional().describe('New status'),
        },
        async (args) => {
          const { id, ...fields } = args;
          const updates: Record<string, unknown> = {};
          if (fields.task !== undefined) updates.task = fields.task;
          if (fields.scheduleValue !== undefined) updates.scheduleValue = fields.scheduleValue;
          if (fields.nextRun !== undefined) updates.nextRun = fields.nextRun;
          if (fields.status !== undefined) updates.status = fields.status;
          store.updateSchedule(id, updates as any);
          return { content: [{ type: 'text' as const, text: `Updated schedule #${id}` }] };
        },
      ),

      tool(
        'search_mcp_registry',
        'Search the official MCP Registry for available servers/integrations. Use this when the user asks to add tools or integrations.',
        { query: z.string().describe('Search query (e.g., "google calendar", "slack", "github")') },
        async (args) => {
          try {
            const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(args.query)}&limit=10`;
            const safe = isSafeOutboundUrl(url);
            if (!safe.ok) return { content: [{ type: 'text' as const, text: `Denied: ${safe.reason}` }] };
            const res = await fetch(url);
            if (!res.ok) return { content: [{ type: 'text' as const, text: `Registry returned ${res.status}` }] };
            const data = await res.json() as { servers?: Array<{ server?: { name?: string; description?: string; repository?: { url?: string } } }> };
            const servers = data.servers ?? [];
            if (servers.length === 0) return { content: [{ type: 'text' as const, text: 'No servers found.' }] };
            const list = servers.map((entry, i) => {
              const s = entry.server ?? {};
              return `${i + 1}. **${s.name ?? 'unknown'}**\n   ${s.description ?? 'No description'}\n   Repo: ${s.repository?.url ?? 'N/A'}`;
            }).join('\n\n');
            return { content: [{ type: 'text' as const, text: list }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Registry error: ${(err as Error).message}` }] };
          }
        },
      ),

      tool(
        'install_tool',
        'Install an MCP server by adding it to .mcp.json. Only install servers found via search_mcp_registry. Always confirm with the user first.',
        {
          name: z.string().describe('Server name (key in .mcp.json)'),
          command: z.string().describe('Command to run the server (npx, node, python, python3, uvx, docker)'),
          args: z.array(z.string()).describe('Command arguments'),
          env: z.record(z.string(), z.string()).optional().describe('Environment variables for the server'),
        },
        async (toolArgs) => {
          const th = throttle('install_tool', 5, 60_000);
          if (!th.ok) return { content: [{ type: 'text' as const, text: th.reason! }] };
          if (!ALLOWED_COMMANDS.has(toolArgs.command)) {
            return { content: [{ type: 'text' as const, text: `Denied: command "${toolArgs.command}" not in allowed list: ${[...ALLOWED_COMMANDS].join(', ')}` }] };
          }

          const joined = [toolArgs.command, ...toolArgs.args].join(' ');
          if (DANGEROUS_ARG_PATTERNS.some(p => p.test(joined))) {
            store.logAudit('tool_install_denied', `${toolArgs.name}: dangerous pattern in "${joined.slice(0, 200)}"`);
            return { content: [{ type: 'text' as const, text: `Denied: arguments match a dangerous pattern.` }] };
          }

          interface McpConfig { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> }
          let mcpConfig: McpConfig = { mcpServers: {} };
          if (existsSync(MCP_JSON_PATH)) {
            try {
              mcpConfig = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8')) as McpConfig;
            } catch (err) {
              console.error('[tools] .mcp.json is corrupt — starting fresh:', (err as Error).message);
            }
          }
          mcpConfig.mcpServers ??= {};
          mcpConfig.mcpServers[toolArgs.name] = {
            command: toolArgs.command,
            args: toolArgs.args,
            ...(toolArgs.env && Object.keys(toolArgs.env).length > 0 ? { env: toolArgs.env } : {}),
          };
          writeFileSync(MCP_JSON_PATH, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
          store.logAudit('tool_installed', toolArgs.name);
          return { content: [{ type: 'text' as const, text: `Installed "${toolArgs.name}". It will be available on the next agent invocation.` }] };
        },
      ),

      tool(
        'remove_tool',
        'Remove an MCP server from .mcp.json',
        { name: z.string().describe('Server name to remove') },
        async (args) => {
          if (!existsSync(MCP_JSON_PATH)) return { content: [{ type: 'text' as const, text: 'No .mcp.json found.' }] };
          try {
            const mcpConfig = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'));
            if (mcpConfig.mcpServers?.[args.name]) {
              delete mcpConfig.mcpServers[args.name];
              writeFileSync(MCP_JSON_PATH, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
              store.logAudit('tool_removed', args.name);
              return { content: [{ type: 'text' as const, text: `Removed "${args.name}".` }] };
            }
            return { content: [{ type: 'text' as const, text: `Server "${args.name}" not found in .mcp.json.` }] };
          } catch (err) {
            console.error('[tools] Error reading .mcp.json in remove_tool:', (err as Error).message);
            store.logAudit('mcp_config_error', `remove_tool: ${(err as Error).message}`);
            return { content: [{ type: 'text' as const, text: 'Error reading .mcp.json — config may be corrupt.' }] };
          }
        },
      ),

      tool(
        'list_tools',
        'List all installed MCP servers from .mcp.json',
        {},
        async () => {
          if (!existsSync(MCP_JSON_PATH)) return { content: [{ type: 'text' as const, text: 'No .mcp.json found. No external tools installed.' }] };
          try {
            const mcpConfig = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'));
            const servers = mcpConfig.mcpServers ?? {};
            const names = Object.keys(servers);
            if (names.length === 0) return { content: [{ type: 'text' as const, text: 'No external tools installed.' }] };
            const list = names.map(n => `- ${n}: ${servers[n].command} ${(servers[n].args ?? []).join(' ')}`).join('\n');
            return { content: [{ type: 'text' as const, text: list }] };
          } catch (err) {
            console.error('[tools] Error reading .mcp.json in list_tools:', (err as Error).message);
            return { content: [{ type: 'text' as const, text: 'Error reading .mcp.json — config may be corrupt.' }] };
          }
        },
      ),

      tool(
        'get_settings',
        'Read the current cakeagent settings',
        {},
        async () => {
          const settings = store.loadSettings();
          return { content: [{ type: 'text' as const, text: JSON.stringify(settings, null, 2) }] };
        },
      ),

      tool(
        'update_settings',
        'Update a cakeagent setting. Changes take effect on the next agent invocation.',
        {
          key: z.string().describe('Setting key (e.g., "model", "assistantName", "triggerPattern", "voiceReceive", "voiceSend")'),
          value: z.string().describe('New value (use "true"/"false" for booleans, numbers as strings)'),
        },
        async (args) => {
          const settings = store.loadSettings();
          const k = args.key as keyof CakeSettings;
          if (!(k in DEFAULT_SETTINGS)) {
            return { content: [{ type: 'text' as const, text: `Unknown setting: ${args.key}` }] };
          }
          if (k === 'model' && !VALID_MODELS.has(args.value)) {
            return { content: [{ type: 'text' as const, text: `Invalid model. Valid: ${[...VALID_MODELS].join(', ')}` }] };
          }
          if (k === 'thinkingLevel' && !VALID_THINKING_LEVELS.has(args.value)) {
            return { content: [{ type: 'text' as const, text: `Invalid thinking level. Valid: ${[...VALID_THINKING_LEVELS].join(', ')}` }] };
          }
          if (k === 'voiceTtsVoice' && !VALID_TTS_VOICE_RE.test(args.value)) {
            return { content: [{ type: 'text' as const, text: 'Invalid TTS voice format. Expected: xx-XX-NameNeural (e.g., en-US-AriaNeural)' }] };
          }
          const current = settings[k];
          if (typeof current === 'boolean') (settings as any)[k] = args.value === 'true';
          else if (typeof current === 'number') (settings as any)[k] = Number(args.value);
          else (settings as any)[k] = args.value;
          store.saveSettings(settings);
          store.logAudit('settings_updated', `${args.key}=${args.value}`);
          return { content: [{ type: 'text' as const, text: `Updated ${args.key} = ${args.value}` }] };
        },
      ),

      tool(
        'register_group',
        'Register a Telegram group chat so cakeagent responds when triggered. Creates a group folder with its own CLAUDE.md.',
        {
          chatId: z.string().describe('Telegram group chat ID (e.g., "-1001234567890")'),
          name: z.string().describe('Human-readable group name'),
          folder: z.string().describe('Folder name under groups/ (e.g., "family-chat")'),
          trigger: z.string().describe('Trigger word to activate the agent in this group (e.g., "@Andy")'),
        },
        async (args) => {
          if (!/^[a-z0-9_-]{1,50}$/i.test(args.folder)) {
            return { content: [{ type: 'text' as const, text: 'Invalid folder name. Use only letters, numbers, hyphens, underscores (max 50 chars).' }] };
          }
          const groupDir = join(groupsDir, args.folder);
          if (!resolve(groupDir).startsWith(resolve(groupsDir) + '/')) {
            return { content: [{ type: 'text' as const, text: 'Invalid folder path.' }] };
          }
          mkdirSync(groupDir, { recursive: true });
          if (!existsSync(join(groupDir, 'CLAUDE.md'))) {
            const identity = store.loadSettings().assistantName;
            writeFileSync(join(groupDir, 'CLAUDE.md'),
              `# ${identity} — Group: ${args.name}\n\nYou are ${identity} in the "${args.name}" group chat.\nOnly respond when triggered with "${args.trigger}".\nRespond in the language of the message.\nBe concise.\n`
            );
          }
          store.registerGroup({ chatId: args.chatId, name: args.name, folder: args.folder, trigger: args.trigger });
          store.logAudit('group_registered', `${args.name} (${args.chatId})`);
          return { content: [{ type: 'text' as const, text: `Registered group "${args.name}" with trigger "${args.trigger}".` }] };
        },
      ),

      tool(
        'list_groups',
        'List all registered group chats',
        {},
        async () => {
          const groups = store.getGroups();
          if (groups.length === 0) return { content: [{ type: 'text' as const, text: 'No groups registered.' }] };
          const list = groups.map(g => `- ${g.name} (${g.chatId}) trigger: ${g.trigger} folder: ${g.folder}`).join('\n');
          return { content: [{ type: 'text' as const, text: list }] };
        },
      ),

      tool(
        'install_skill',
        'Install a skill from skills.sh. Skills provide knowledge and CLI tools for services like Gmail, Outlook, Slack. Browse https://skills.sh to find skills, then install by source identifier.',
        {
          source: z.string().describe('skills.sh identifier: "owner/repo/skill" (e.g., "dandcg/claude-skills/outlook")'),
        },
        async (args) => {
          const parts = args.source.replace(/^https?:\/\/skills\.sh\//, '').split('/');
          if (parts.length < 3) {
            return { content: [{ type: 'text' as const, text: 'Invalid source. Use format: owner/repo/skill (e.g., "dandcg/claude-skills/outlook")' }] };
          }
          const [owner, repo, ...rest] = parts;
          const skill = rest.join('/');
          const name = rest[rest.length - 1];

          // Validate identifiers — prevent path traversal and SSRF
          const IDENT_RE = /^[a-zA-Z0-9_-]{1,100}$/;
          if (!IDENT_RE.test(owner) || !IDENT_RE.test(repo) || !IDENT_RE.test(name)) {
            return { content: [{ type: 'text' as const, text: 'Invalid characters in source identifier. Owner, repo, and skill name must be alphanumeric.' }] };
          }

          const th = throttle('install_skill', 10, 60_000);
          if (!th.ok) return { content: [{ type: 'text' as const, text: th.reason! }] };

          const index = store.loadSkillIndex();
          if (index[name]) {
            return { content: [{ type: 'text' as const, text: `Skill "${name}" is already installed. Remove it first with remove_skill.` }] };
          }

          // Fetch SKILL.md from GitHub, resolving the branch to a commit SHA so
          // subsequent reads can be pinned. Try main then master.
          let content = '';
          let resolvedSha: string | null = null;
          let resolvedRef: string | null = null;
          for (const branch of ['main', 'master']) {
            const shaUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`;
            const safeSha = isSafeOutboundUrl(shaUrl);
            if (!safeSha.ok) {
              return { content: [{ type: 'text' as const, text: `Denied: ${safeSha.reason}` }] };
            }
            try {
              const shaRes = await fetch(shaUrl, { headers: { 'Accept': 'application/vnd.github+json' } });
              if (!shaRes.ok) continue;
              const shaJson = await shaRes.json() as { sha?: string };
              if (!shaJson.sha || !/^[a-f0-9]{40}$/.test(shaJson.sha)) continue;
              const url = `https://raw.githubusercontent.com/${owner}/${repo}/${shaJson.sha}/${skill}/SKILL.md`;
              const safeUrl = isSafeOutboundUrl(url);
              if (!safeUrl.ok) {
                return { content: [{ type: 'text' as const, text: `Denied: ${safeUrl.reason}` }] };
              }
              const res = await fetch(url);
              if (res.ok) {
                content = await res.text();
                resolvedSha = shaJson.sha;
                resolvedRef = branch;
                break;
              }
            } catch { /* try next branch */ }
          }
          if (!content || !resolvedSha) {
            return { content: [{ type: 'text' as const, text: `Could not fetch SKILL.md from github.com/${owner}/${repo}/${skill}. Check the source identifier.` }] };
          }

          const MAX_SKILL_SIZE = 50 * 1024;
          if (content.length > MAX_SKILL_SIZE) {
            return { content: [{ type: 'text' as const, text: `Skill content too large (${content.length} bytes, max ${MAX_SKILL_SIZE}). Rejecting.` }] };
          }

          // Sanitize and store skill
          const sanitized = sanitizeMemory(content);
          const skillsDir = join(dataDir, 'skills');
          mkdirSync(skillsDir, { recursive: true });
          writeFileSync(join(skillsDir, `${name}.md`), sanitized);

          // First non-empty, non-heading line becomes the lazy-load summary.
          const summary = sanitized.split('\n')
            .map(l => l.trim())
            .find(l => l && !l.startsWith('#')) ?? '';

          index[name] = {
            owner, repo, skill,
            installedAt: new Date().toISOString().slice(0, 10),
            sha: resolvedSha,
            ref: resolvedRef ?? undefined,
            summary: summary.slice(0, 200),
          };
          store.saveSkillIndex(index);
          store.logAudit('skill_installed', `${name} from ${args.source} @ ${resolvedSha.slice(0, 10)}`);

          return { content: [{ type: 'text' as const, text: `Installed skill "${name}" pinned at ${resolvedSha.slice(0, 10)}. Call read_skill("${name}") to read the full setup instructions.` }] };
        },
      ),

      tool(
        'list_skills',
        'List all installed skills from skills.sh with their pinned commit SHA',
        {},
        async () => {
          const index = store.loadSkillIndex();
          const names = Object.keys(index);
          if (names.length === 0) return { content: [{ type: 'text' as const, text: 'No skills installed. Browse https://skills.sh to find skills.' }] };
          const list = names.map(n => {
            const m = index[n]!;
            const pin = m.sha ? ` @ ${m.sha.slice(0, 10)}` : '';
            return `- ${n} (${m.owner}/${m.repo}${pin}, installed ${m.installedAt})${m.summary ? `\n  ${m.summary}` : ''}`;
          }).join('\n');
          return { content: [{ type: 'text' as const, text: list }] };
        },
      ),

      tool(
        'read_skill',
        'Read the full body of an installed skill. Use this after seeing the lazy-loaded skill index in your prompt to load setup instructions for a specific integration.',
        { name: z.string().describe('Skill name as shown in list_skills') },
        async (args) => {
          const body = store.readSkill(args.name);
          if (body == null) return { content: [{ type: 'text' as const, text: `Skill "${args.name}" not found.` }] };
          return { content: [{ type: 'text' as const, text: body }] };
        },
      ),

      tool(
        'search_messages',
        'Full-text search across stored message history. Use for cross-session recall ("what did we discuss about X last month?").',
        {
          query: z.string().describe('Search query. Supports FTS5 phrase syntax; quotes are stripped.'),
          chatId: z.string().optional().describe('Restrict to a specific chat'),
          sinceDays: z.number().optional().describe('Only messages newer than N days'),
          limit: z.number().optional().describe('Max results (default 20, max 200)'),
        },
        async (args) => {
          const since = args.sinceDays ? Date.now() - args.sinceDays * 86_400_000 : 0;
          const hits = store.searchMessages(args.query, { chatId: args.chatId, since, limit: args.limit });
          if (hits.length === 0) return { content: [{ type: 'text' as const, text: 'No matches.' }] };
          const list = hits.map(h => {
            const when = new Date(h.timestamp).toISOString().slice(0, 16).replace('T', ' ');
            return `[${when}] ${h.sender_name}: ${(h.content ?? '').slice(0, 300)}`;
          }).join('\n');
          return { content: [{ type: 'text' as const, text: `${hits.length} match(es)${store.hasFts() ? '' : ' (LIKE fallback — FTS5 unavailable)'}:\n${list}` }] };
        },
      ),

      tool(
        'list_audit_events',
        'Review the audit log for security events (blocked commands, injections, tool installs, rate limits). Useful when the user asks what the agent has been blocked from doing, or to review recent activity.',
        {
          event: z.string().optional().describe('Filter by event name (e.g. "bash_denied", "injection_detected", "skill_installed")'),
          sinceHours: z.number().optional().describe('Only events from the last N hours'),
          limit: z.number().optional().describe('Max results (default 50, max 500)'),
        },
        async (args) => {
          const since = args.sinceHours
            ? new Date(Date.now() - args.sinceHours * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
            : undefined;
          const rows = store.listAuditEvents({ event: args.event, since, limit: args.limit });
          if (rows.length === 0) return { content: [{ type: 'text' as const, text: 'No audit events match.' }] };
          const lines = rows.map(r => `#${r.id} [${r.created_at}] ${r.event}: ${r.detail ?? ''}`);
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        },
      ),

      tool(
        'remove_skill',
        'Remove an installed skill',
        { name: z.string().describe('Skill name to remove') },
        async (args) => {
          if (/[./\\]/.test(args.name)) {
            return { content: [{ type: 'text' as const, text: 'Invalid skill name.' }] };
          }
          const index = store.loadSkillIndex();
          if (!index[args.name]) {
            return { content: [{ type: 'text' as const, text: `Skill "${args.name}" not found.` }] };
          }
          delete index[args.name];
          store.saveSkillIndex(index);
          const mdPath = join(dataDir, 'skills', `${args.name}.md`);
          try { unlinkSync(mdPath); } catch { /* ignore */ }
          store.logAudit('skill_removed', args.name);
          return { content: [{ type: 'text' as const, text: `Removed skill "${args.name}".` }] };
        },
      ),

      tool(
        'update_memory',
        'Append a new entry to persistent memory. Use for new preferences, facts, or context.',
        { content: z.string().describe('Content to add to memory') },
        async (args) => {
          const memPath = join(dataDir, 'memory.md');
          const sanitized = sanitizeMemory(args.content);
          if (!sanitized.trim()) return { content: [{ type: 'text' as const, text: 'Content was empty after sanitization.' }] };
          const entry = `\n## ${new Date().toISOString().slice(0, 10)}\n${sanitized}\n`;
          const existing = existsSync(memPath) ? readFileSync(memPath, 'utf-8') : '';
          writeFileSync(memPath + '.tmp', existing + entry);
          renameSync(memPath + '.tmp', memPath);
          return { content: [{ type: 'text' as const, text: 'Memory updated.' }] };
        },
      ),

      tool(
        'rewrite_memory',
        'Replace the entire persistent memory with cleaned-up, reorganized content. Use this to remove outdated entries, merge duplicates, and keep memory concise. The full current memory is in the [MEMORY] block at the top of your prompt — review it before rewriting.',
        { content: z.string().describe('Complete new memory content (replaces everything)') },
        async (args) => {
          const memPath = join(dataDir, 'memory.md');
          const sanitized = sanitizeMemory(args.content);
          if (!sanitized.trim()) return { content: [{ type: 'text' as const, text: 'Content was empty after sanitization.' }] };
          writeFileSync(memPath + '.tmp', sanitized);
          renameSync(memPath + '.tmp', memPath);
          store.logAudit('memory_rewritten', `${sanitized.length} chars`);
          return { content: [{ type: 'text' as const, text: `Memory rewritten (${sanitized.length} chars).` }] };
        },
      ),
    ],
  });
}
