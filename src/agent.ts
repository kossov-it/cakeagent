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
  onText?: (text: string) => Promise<void>,
): Promise<{ sessionId: string; result: string }> {
  const groupPath = resolve(deps.groupsDir, params.groupFolder);

  let externalMcp: Record<string, any> = {};
  if (existsSync(MCP_JSON_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'));
      externalMcp = raw.mcpServers ?? {};
    } catch { /* ignore */ }
  }

  let sessionId = params.sessionId ?? '';
  let result = '';
  let lastStreamedText = '';

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

      if (message.type === 'assistant' && onText) {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              const text = block.text.trim();
              if (text && text !== lastStreamedText) {
                await onText(text);
                lastStreamedText = text;
              }
            }
          }
        }
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
