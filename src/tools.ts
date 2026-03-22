import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as store from './store.js';
import type { SharedState, CakeSettings } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

const MCP_JSON_PATH = resolve('.mcp.json');
const ALLOWED_COMMANDS = new Set(['npx', 'node', 'python', 'python3', 'uvx', 'docker']);

// Sanitize content before writing to memory — strip obvious injection patterns
function sanitizeMemory(content: string): string {
  const INJECTION_RE = [
    /ignore\s+(all\s+)?(previous|prior)\s+(instructions?|prompts?)/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /system\s*:\s*(prompt|override|command)/i,
    /\[System\s*Message\]/i,
  ];
  return content.split('\n').filter(line => !INJECTION_RE.some(p => p.test(line))).join('\n');
}

export function createTools(state: SharedState, dataDir: string, groupsDir: string) {
  return createSdkMcpServer({
    name: 'cakeagent',
    version: '0.1.0',
    tools: [
      // === Messaging ===
      tool(
        'send_message',
        'Send a message to the user immediately (for progress updates or multi-part responses)',
        { text: z.string().describe('Message text to send') },
        async (args) => {
          // Actual sending happens in PostToolUse hook via shared state
          // chatId is injected by the hook from the current context
          return { content: [{ type: 'text' as const, text: `Message queued: "${args.text.slice(0, 50)}..."` }] };
        },
      ),

      // === Scheduling ===
      tool(
        'schedule_task',
        'Create a scheduled or recurring task. Use cron for recurring, once for one-time reminders.',
        {
          task: z.string().describe('What the agent should do when the task fires'),
          scheduleType: z.enum(['cron', 'interval', 'once']).describe('Type of schedule'),
          scheduleValue: z.string().describe('Cron expression, interval in ms, or ISO timestamp'),
          nextRun: z.string().describe('ISO 8601 timestamp of the next execution'),
          contextMode: z.enum(['group', 'isolated']).default('isolated')
            .describe('group = run with chat history, isolated = fresh session'),
        },
        async (args) => {
          // Actual creation happens in PostToolUse hook via shared state
          return { content: [{ type: 'text' as const, text: `Task scheduled: "${args.task.slice(0, 80)}" — next run: ${args.nextRun}` }] };
        },
      ),

      tool(
        'list_schedules',
        'List all scheduled tasks',
        {},
        async () => {
          const tasks = store.getAllSchedules();
          if (tasks.length === 0) return { content: [{ type: 'text' as const, text: 'No scheduled tasks.' }] };
          const list = tasks.map(t => `#${t.id} [${t.status}] ${t.task} (${t.scheduleType}: ${t.scheduleValue}, next: ${t.nextRun})`).join('\n');
          return { content: [{ type: 'text' as const, text: list }] };
        },
      ),

      tool(
        'delete_schedule',
        'Delete a scheduled task by ID',
        { id: z.number().describe('Schedule ID to delete') },
        async (args) => {
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

      // === MCP Tool Management ===
      tool(
        'search_mcp_registry',
        'Search the official MCP Registry for available servers/integrations. Use this when the user asks to add tools or integrations.',
        { query: z.string().describe('Search query (e.g., "google calendar", "slack", "github")') },
        async (args) => {
          try {
            const url = `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(args.query)}&limit=10`;
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
          if (!ALLOWED_COMMANDS.has(toolArgs.command)) {
            return { content: [{ type: 'text' as const, text: `Denied: command "${toolArgs.command}" not in allowed list: ${[...ALLOWED_COMMANDS].join(', ')}` }] };
          }

          const DANGEROUS_ARG_PATTERNS = [/--eval\b/, /-e\s/, /-c\s/, /\$\(/, /`/, /\|\s*sh/, /;\s*rm/];
          const dangerousArg = toolArgs.args.find(a => DANGEROUS_ARG_PATTERNS.some(p => p.test(a)));
          if (dangerousArg) {
            store.logAudit('tool_install_denied', `${toolArgs.name}: dangerous arg "${dangerousArg}"`);
            return { content: [{ type: 'text' as const, text: `Denied: argument "${dangerousArg}" matches a dangerous pattern.` }] };
          }

          let mcpConfig: any = { mcpServers: {} };
          if (existsSync(MCP_JSON_PATH)) {
            try { mcpConfig = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8')); } catch { /* start fresh */ }
          }
          mcpConfig.mcpServers ??= {};
          mcpConfig.mcpServers[toolArgs.name] = {
            command: toolArgs.command,
            args: toolArgs.args,
            ...(toolArgs.env && Object.keys(toolArgs.env).length > 0 ? { env: toolArgs.env } : {}),
          };
          writeFileSync(MCP_JSON_PATH, JSON.stringify(mcpConfig, null, 2));
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
              writeFileSync(MCP_JSON_PATH, JSON.stringify(mcpConfig, null, 2));
              store.logAudit('tool_removed', args.name);
              return { content: [{ type: 'text' as const, text: `Removed "${args.name}".` }] };
            }
            return { content: [{ type: 'text' as const, text: `Server "${args.name}" not found in .mcp.json.` }] };
          } catch {
            return { content: [{ type: 'text' as const, text: 'Error reading .mcp.json.' }] };
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
          } catch {
            return { content: [{ type: 'text' as const, text: 'Error reading .mcp.json.' }] };
          }
        },
      ),

      // === Settings ===
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
          key: z.string().describe('Setting key (e.g., "model", "assistantName", "triggerPattern", "voiceReceive", "voiceReply")'),
          value: z.string().describe('New value (use "true"/"false" for booleans, numbers as strings)'),
        },
        async (args) => {
          const settings = store.loadSettings();
          const k = args.key as keyof CakeSettings;
          if (!(k in DEFAULT_SETTINGS)) {
            return { content: [{ type: 'text' as const, text: `Unknown setting: ${args.key}` }] };
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

      // === Groups ===
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

      // === Memory ===
      tool(
        'update_memory',
        'Append a new entry to persistent memory. Use for new preferences, facts, or context.',
        { content: z.string().describe('Content to add to memory') },
        async (args) => {
          const memPath = join(dataDir, 'memory.md');
          const sanitized = sanitizeMemory(args.content);
          if (!sanitized.trim()) return { content: [{ type: 'text' as const, text: 'Content was empty after sanitization.' }] };
          const entry = `\n## ${new Date().toISOString().slice(0, 10)}\n${sanitized}\n`;
          appendFileSync(memPath, entry);
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
          writeFileSync(memPath, sanitized);
          store.logAudit('memory_rewritten', `${sanitized.length} chars`);
          return { content: [{ type: 'text' as const, text: `Memory rewritten (${sanitized.length} chars).` }] };
        },
      ),
    ],
  });
}
