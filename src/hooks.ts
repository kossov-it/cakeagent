import type { SharedState } from './types.js';
import { logAudit } from './store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deny patterns for Bash commands — obvious shell injection / exfiltration
const BASH_DENY = [
  /\$\(/,                              // command substitution
  /`[^`]+`/,                           // backtick execution
  /\|\s*(ba)?sh\b/,                    // pipe to shell
  /\|\s*zsh\b/,
  /;\s*rm\s+-rf?\s/,                   // destructive chained rm
  /\bnc\b.*-[elp]/,                    // netcat listeners
  /\bncat\b/,
  /\b(curl|wget)\b.*\|\s*(ba)?sh/,     // download-and-execute
  /\beval\b/,                          // eval
  /\/dev\/(tcp|udp)\//,                // bash reverse shell
  /\bmkfifo\b/,                        // named pipe (often reverse shell)
  /\bpython[23]?\s+-c\s/,             // inline python execution
  /\bperl\s+-e\s/,                     // inline perl
  /\bcat\b.*\.(env|pem)\b/,           // read secrets via cat
  /\bcat\b.*\/etc\/(shadow|passwd)/,   // read system auth files
  /\bcat\b.*id_rsa/,                   // read SSH keys
  /\bcat\b.*\.ssh\//,                  // read SSH directory
  /\bsed\b.*\.env/,                    // modify .env via sed
  /\bsystemctl\b.*sshd/,              // modify SSH service
  /\bpasswd\b/,                        // change passwords
  /\busermod\b/,                       // modify users
  /\bchmod\b.*\.ssh/,                  // change SSH permissions
];

// Protected file paths — agent must not modify these
const PROTECTED_PATHS = [
  /CLAUDE\.md$/i,
  /\.claude\//,
  /\.env$/,
  /credentials\//,
  /\.ssh\//,
  /\/etc\//,
];

/**
 * Build hook matchers for the Agent SDK.
 *
 * Returns an object suitable for `query({ options: { hooks } })`.
 * Hooks use closures to access shared state without IPC.
 */
export function createHooks(state: SharedState, groupsDir = './groups') {
  return {
    PreToolUse: [
      // 1. Bash command validator
      {
        matcher: '^Bash$',
        hooks: [async (input: any) => {
          const command: string = input.tool_input?.command ?? '';
          const denied = BASH_DENY.find(p => p.test(command));
          if (denied) {
            logAudit('bash_denied', command.slice(0, 500));
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Command matches a blocked pattern',
              },
            };
          }
          logAudit('bash_allowed', command.slice(0, 200));
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          };
        }],
      },
      // 2. Block reading sensitive files
      {
        matcher: '^Read$',
        hooks: [async (input: any) => {
          const filePath: string = input.tool_input?.file_path ?? '';
          const SENSITIVE = [/\.env$/, /\.ssh\//, /credentials\//, /\/etc\/shadow/, /\/etc\/passwd/, /id_rsa/, /\.pem$/];
          const blocked = SENSITIVE.find(p => p.test(filePath));
          if (blocked) {
            logAudit('read_denied', filePath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Sensitive file — access blocked',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          };
        }],
      },
      // 3. Block writing to protected files
      {
        matcher: '^(Write|Edit)$',
        hooks: [async (input: any) => {
          const filePath: string = input.tool_input?.file_path ?? '';
          const blocked = PROTECTED_PATHS.find(p => p.test(filePath));
          if (blocked) {
            logAudit('file_denied', filePath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Protected file — use update_memory tool instead',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          };
        }],
      },
    ],
    PostToolUse: [
      // 3. Outbound message interceptor — captures send_message calls
      {
        matcher: '^mcp__cakeagent__',
        hooks: [async (input: any) => {
          const toolName: string = input.tool_name ?? '';
          const toolInput = input.tool_input ?? {};

          if (toolName === 'mcp__cakeagent__send_message') {
            state.pendingMessages.push({ chatId: '', text: toolInput.text ?? '' });
            return { async: true };
          }

          if (toolName === 'mcp__cakeagent__schedule_task') {
            state.pendingSchedules.push({
              action: 'create',
              task: {
                groupFolder: toolInput.groupFolder ?? 'main',
                chatId: toolInput.chatId ?? '',
                task: toolInput.task ?? '',
                scheduleType: toolInput.scheduleType ?? 'once',
                scheduleValue: toolInput.scheduleValue ?? '',
                contextMode: toolInput.contextMode ?? 'isolated',
                nextRun: toolInput.nextRun ?? '',
                status: 'active',
              },
            });
            return { async: true };
          }

          return {};
        }],
      },
    ],
    PreCompact: [
      // 4. Archive conversation before SDK compacts it
      {
        matcher: '.*',
        hooks: [async (input: any) => {
          try {
            const sessionId = input.session_id ?? 'unknown';
            const groupFolder = state.currentGroupFolder ?? 'main';
            const archiveDir = join(groupsDir, groupFolder, 'conversations');
            mkdirSync(archiveDir, { recursive: true });
            const date = new Date().toISOString().slice(0, 10);
            const filename = `${date}-${sessionId.slice(0, 8)}.md`;
            const note = `# Conversation archived ${new Date().toISOString()}\nSession: ${sessionId}\n\n(Full transcript was compacted by the SDK)\n`;
            writeFileSync(join(archiveDir, filename), note);
            logAudit('precompact', `Archived session ${sessionId}`);
          } catch { /* best effort */ }
          return {};
        }],
      },
    ],
  };
}
