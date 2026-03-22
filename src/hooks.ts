import type { SharedState } from './types.js';
import { logAudit } from './store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deny patterns for Bash commands — defense-in-depth layer
// Primary security: systemd sandboxing + limited sudoers + file path hooks
// $() is allowed for legitimate CLI use (skills, jq, date, etc.)
// Only dangerous subshell patterns are blocked (curl/wget exfil, rm/dd/mv destructive)
const BASH_DENY = [
  // Shell injection / inline execution
  /\$\(\s*(curl|wget)\b/,              // subshell exfiltration
  /\$\(\s*(rm|dd|mv)\b/,              // subshell destructive
  /`[^`]+`/,                           // backtick execution
  /\|\s*(ba)?sh\b/,                    // pipe to shell
  /\|\s*zsh\b/,
  /\b(curl|wget)\b.*\|\s*(ba)?sh/,     // download-and-execute
  /\beval\b/,                          // eval
  /\b(ba)?sh\s+-c[\s"']/,              // bash -c, sh -c
  /\bzsh\s+-c[\s"']/,                  // zsh -c
  /\bpython[23]?\s+-c[\s"']/,         // python -c
  /\bperl\s+-e[\s"']/,                // perl -e
  /\bnode\s+-e[\s"']/,                // node -e
  /\bruby\s+-e[\s"']/,                // ruby -e
  /\bphp\s+-r[\s"']/,                 // php -r

  // Reverse shells / exfiltration
  /\bnc\b.*-[elp]/,                    // netcat listeners
  /\bncat\b/,
  /\/dev\/(tcp|udp)\//,                // bash reverse shell
  /\bmkfifo\b/,                        // named pipe

  // Destructive operations
  /;\s*rm\s+-rf?\s/,                   // chained destructive rm
  /\bdd\b.*\bof=/,                     // disk write

  // Secret access
  /\b(cat|less|more|head|tail)\b.*\.(env|pem)\b/,
  /\b(cat|less|more|head|tail)\b.*\/etc\/(shadow|passwd)/,
  /\b(cat|less|more|head|tail)\b.*id_rsa/,
  /\b(cat|less|more|head|tail)\b.*\.ssh\//,
  /\b(cat|less|more|head|tail)\b.*credentials\//,
  /\bsed\b.*\.env/,

  // System administration — allow service management, protect critical services
  /\bsystemctl\b.*\b(sshd|ssh|cakeagent|networking|nftables|firewalld|ufw)\b/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\bpasswd\b/,
  /\busermod\b/,
  /\buseradd\b/,
  /\buserdel\b/,
  /\bvisudo\b/,
  /\bcrontab\b/,

  // Filesystem security
  /\bchmod\b.*\.(ssh|env|pem)/,
  /\bchown\b.*\.(ssh|env|pem)/,
  /\biptables\b/,
  /\bnft\b/,

  // Source code protection — block bash writes to project files
  />\s*\S*\/src\//,                    // redirect to src/
  />\s*\S*\/channels\//,              // redirect to channels/
  />\s*\S*\/dist\//,                  // redirect to dist/
  /\bsed\s+-i\b.*\/(src|channels|dist)\//,  // in-place edit of source
  /\btee\b.*\/(src|channels|dist)\//,       // tee to source
  /\bcp\b.*\/(src|channels|dist)\//,        // copy over source
  /\bmv\b.*\/(src|channels|dist)\//,        // move over source
  />\s*\S*\/data\/skills\//,          // redirect to skills directory
  /\bnpm\s+run\s+build\b/,           // block recompiling (only /update should build)
];

// Protected file paths — agent must not modify these
const SENSITIVE_PATHS = [/\.env$/, /\.ssh\//, /credentials\//, /\/etc\/shadow/, /\/etc\/passwd/, /id_rsa/, /\.pem$/];

const PROTECTED_PATHS = [
  /CLAUDE\.md$/i,
  /\.claude\//,
  /\.env$/,
  /credentials\//,
  /\.ssh\//,
  /\/etc\//,
  /\.pem$/,
  /\/src\//,
  /\/channels\//,
  /\/dist\//,
  /package\.json$/,
  /tsconfig\.json$/,
  /id_rsa/,
  /skills\/index\.json$/,
];

export function createHooks(state: SharedState, groupsDir = './groups') {
  return {
    PreToolUse: [
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
      {
        matcher: '^Read$',
        hooks: [async (input: any) => {
          const filePath: string = input.tool_input?.file_path ?? '';
          const blocked = SENSITIVE_PATHS.find(p => p.test(filePath));
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
      {
        matcher: '^Grep$',
        hooks: [async (input: any) => {
          const searchPath: string = input.tool_input?.path ?? '';
          const blocked = SENSITIVE_PATHS.find(p => p.test(searchPath));
          if (blocked) {
            logAudit('grep_denied', searchPath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Sensitive path — search blocked',
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
      {
        matcher: '^Glob$',
        hooks: [async (input: any) => {
          const searchPath: string = input.tool_input?.path ?? '';
          const blocked = [/\.ssh\//, /credentials\//, /\.env$/, /\.pem$/].find(p => p.test(searchPath));
          if (blocked) {
            logAudit('glob_denied', searchPath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Sensitive directory — enumeration blocked',
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
    PostToolUse: [],
    PreCompact: [
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
