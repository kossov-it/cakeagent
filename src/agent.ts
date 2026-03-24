import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRunParams, CakeSettings } from './types.js';

const MCP_JSON_PATH = resolve('.mcp.json');

interface AgentDeps {
  picoServer: ReturnType<typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer>;
  hooks: Record<string, HookCallbackMatcher[]>;
  settings: CakeSettings;
  groupsDir: string;
}

export async function runAgent(
  params: AgentRunParams,
  deps: AgentDeps,
  onText?: (text: string) => Promise<void>,
): Promise<{ sessionId: string; result: string; timedOut: boolean }> {
  const groupPath = resolve(deps.groupsDir, params.groupFolder);

  let externalMcp: Record<string, any> = {};
  if (existsSync(MCP_JSON_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(MCP_JSON_PATH, 'utf-8'));
      externalMcp = raw.mcpServers ?? {};
    } catch (err) {
      console.error('[agent] .mcp.json is corrupt — starting without external MCP servers:', (err as Error).message);
    }
  }

  let sessionId = params.sessionId ?? '';
  let result = '';
  let lastStreamedText = '';
  let timedOut = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, deps.settings.agentTimeoutMs);

  try {
    for await (const message of query({
      prompt: params.prompt,
      options: {
        cwd: groupPath,
        resume: params.sessionId || undefined,
        model: deps.settings.model || undefined,
        thinking: deps.settings.thinkingLevel === 'off'
          ? { type: 'disabled' as const }
          : { type: 'adaptive' as const },
        effort: deps.settings.thinkingLevel === 'off' ? undefined
          : (deps.settings.thinkingLevel as 'low' | 'medium' | 'high'),
        permissionMode: 'acceptEdits',
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'Agent',
          'mcp__cakeagent__*',
        ],
        agents: {
          worker: {
            description: 'General-purpose worker for complex subtasks. Use when a task benefits from isolated context — research, multi-step file operations, or any work that would clutter the main conversation.',
            prompt: 'You are a worker agent for a personal AI assistant. Complete the assigned task thoroughly and return concise results. You have the same tools as the main agent.',
          },
        },
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
      // Explicit casts avoid expensive narrowing on SDKMessage's 20+ type union.
      // Fields are verified against sdk.d.ts: SDKSystemMessage, SDKAssistantMessage, SDKResultSuccess/Error.
      const msg = message as { type: string; subtype?: string; session_id?: string;
        message?: { content?: Array<{ type: string; text?: string }> };
        result?: string; errors?: string[] };

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id ?? sessionId;
      }

      if (msg.type === 'assistant' && onText && Array.isArray(msg.message?.content)) {
        for (const block of msg.message!.content!) {
          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text && text !== lastStreamedText) {
              await onText(text);
              lastStreamedText = text;
            }
          }
        }
      }

      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          result = msg.result ?? '';
        } else {
          result = msg.errors?.[0] ?? `Agent stopped: ${msg.subtype}`;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return { sessionId, result, timedOut };
}
