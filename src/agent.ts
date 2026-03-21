import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRunParams, CakeSettings } from './types.js';

const MCP_JSON_PATH = resolve('.mcp.json');

interface AgentDeps {
  picoServer: ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer>;
  hooks: Record<string, any>;
  settings: CakeSettings;
  groupsDir: string;
}

export async function runAgent(
  params: AgentRunParams,
  deps: AgentDeps,
): Promise<{ sessionId: string; result: string }> {
  const groupPath = resolve(deps.groupsDir, params.groupFolder);

  // Load external MCP servers from .mcp.json
  let externalMcp: Record<string, any> = {};
  if (existsSync(MCP_JSON_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'));
      externalMcp = raw.mcpServers ?? {};
    } catch { /* ignore parse errors */ }
  }

  let sessionId = params.sessionId ?? '';
  let result = '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.settings.agentTimeoutMs);

  try {
    for await (const message of query({
      prompt: params.prompt,
      options: {
        cwd: groupPath,
        resume: params.sessionId || undefined,
        model: deps.settings.model || undefined,
        thinking: deps.settings.thinkingLevel === 'off'
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budgetTokens: ({ low: 1024, medium: 5120, high: 10240 } as Record<string, number>)[deps.settings.thinkingLevel] ?? 1024 },
        permissionMode: 'acceptEdits',
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__cakeagent__*',
        ],
        settingSources: ['project'],
        maxTurns: 25,
        mcpServers: {
          cakeagent: deps.picoServer,
          ...externalMcp,
        },
        hooks: deps.hooks,
        abortController: controller,
      },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = (message as any).session_id ?? sessionId;
      }
      if (message.type === 'result') {
        result = (message as any).result ?? '';
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return { sessionId, result };
}
