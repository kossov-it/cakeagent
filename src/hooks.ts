import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { SharedState } from './types.js';
import { logAudit, getMessagesSince } from './store.js';
import { mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Normalize command for pattern matching — strip quotes to prevent bypass
export function normalizeCommand(cmd: string): string {
  return cmd.replace(/["'\\]/g, '');
}

/** Test helper: returns the first BASH_DENY pattern matching `cmd`, or null. */
export function findBashDeny(cmd: string): RegExp | null {
  const normalized = normalizeCommand(cmd);
  return BASH_DENY.find(p => p.test(normalized)) ?? null;
}

/** Test helper: returns the first SENSITIVE_PATHS pattern matching `p`, or null. */
export function findSensitivePath(p: string): RegExp | null {
  return SENSITIVE_PATHS.find(r => r.test(p)) ?? null;
}

/** Test helper: returns the first PROTECTED_PATHS pattern matching `p`, or null. */
export function findProtectedPath(p: string): RegExp | null {
  return PROTECTED_PATHS.find(r => r.test(p)) ?? null;
}

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

  // Secret access — block reading sensitive files via common viewers
  /\b(cat|less|more|head|tail)\b.*(\.(env|pem)\b|\/etc\/(shadow|passwd)|id_rsa|\.ssh\/|credentials\/)/,
  /\bsed\b.*\.env/,
  /^\s*env\s*($|\|)/,                       // bare env or env piped (dumps all environment variables)
  /\bprintenv\b/,                            // printenv (any form — no legitimate agent use)

  // Critical system files — block all access via Bash (reads, writes, redirects)
  // Agent can still configure nginx, mysql, letsencrypt, systemd services, sysctl.d, sources.list.d
  // via `sudo bash setup.sh install-config <path>` which validates the target against an allowlist.
  /\/etc\/(shadow|passwd|group|gshadow)(-|\b)/,
  /\/etc\/sudoers(\.d)?\b/,
  /\/etc\/ssh\//,
  /\/etc\/pam\.d(\/|\b)/,
  /\/etc\/security(\/|\b)/,
  /\/etc\/ld\.so\.(preload|conf(\.d)?)(\/|\b)/,
  /\/etc\/profile(\.d)?(\/|\b)/,
  /\/etc\/bash\.bashrc\b/,
  /\/etc\/environment\b/,
  /\/etc\/cron\.(d|daily|hourly|monthly|weekly)(\/|\b)/,
  /\/etc\/crontab\b/,
  /\/etc\/hosts\b/,
  /\/etc\/resolv\.conf\b/,
  /\/etc\/hostname\b/,
  /\/etc\/fstab\b/,
  /\/etc\/nsswitch\.conf\b/,
  /\/etc\/sysctl\.conf\b/,
  /\/etc\/apt\/sources\.list(?!\.d)/,
  /\/etc\/apt\/trusted\.gpg/,
  /\/etc\/systemd\/system\/cakeagent/,

  // System administration — allow service management, protect critical services
  /\bsystemctl\b.*\b(sshd|ssh|cakeagent|networking)\b/,
  /\bsystemctl\b.*\b(stop|disable)\b.*\b(nftables|firewalld|ufw)\b/,
  /\bsystemctl\b.*\bmask\b/,             // persistent service disable
  /\breboot\b/,
  /\bshutdown\b/,
  /\bpasswd\b/,
  /\busermod\b/,
  /\buseradd\b/,
  /\buserdel\b/,
  /\bvisudo\b/,

  // Filesystem security
  /\bchmod\b.*\.(ssh|env|pem)/,
  /\bchown\b.*\.(ssh|env|pem)/,
  // Firewall — allow rule management, block destructive operations
  /\bnft\s+flush\b/,                            // block wiping all rules
  /\bnft\s+delete\s+table\b/,                   // block destroying entire tables
  /\biptables\s+-[FXZ]\b/,                      // block flush/delete/zero chains
  /\biptables\s+-P\b.*\bACCEPT\b/,             // block default-accept policy
  /\b(nft|iptables)\b.*\bdport\s+22\b/,        // protect SSH port

  // Source code protection — block bash writes to project files
  />\s*\S*\/(src|channels|dist)\//,                      // redirect to source dirs
  /\b(sed\s+-i|tee|cp|mv)\b.*\/(src|channels|dist)\//,  // in-place edit/copy/move to source
  />\s*\S*\/data\/skills\//,          // redirect to skills directory
  /\bnpm\s+run\s+build\b/,           // block recompiling (only /update should build)

  // Enhanced validators — Unicode, control chars, process substitution, etc.
  /[\u00A0\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/, // unicode whitespace — invisible command separators
  /[\x00-\x08\x0B\x0C\x0E-\x1F]/,                       // control characters — parser confusion
  /\bIFS\s*=/,                                            // IFS injection — changes field separator
  /<\(/,                                                  // process substitution <()
  />\(/,                                                  // process substitution >()
  /\{[^}]*[;&|][^}]*\}/,                                 // brace expansion with dangerous content
  /\/proc\/(self|\d+)\/environ/,                          // reads process environment variables
  /\b(zmodload|zpty|ztcp|zsocket|sysopen|sysread|syswrite)\b/, // zsh dangerous builtins
  /\bjq\b.*@base64d/,                                    // jq system function — shell exec via decode
  /--\$[{(]/,                                             // obfuscated flags hiding intent
];

// Protected file paths — agent must not modify these
const SENSITIVE_PATHS = [/\.env$/, /\.ssh\//, /credentials\//, /\/etc\/shadow/, /\/etc\/passwd/, /id_rsa/, /\.pem$/];

// Write/Edit is blocked for these paths. Note that /etc/ writes will also fail
// due to file ownership (cakeagent user can't write root-owned files); this
// layer is belt-and-suspenders and covers symlinked bypasses. The canonical
// write path for /etc/ is `sudo bash setup.sh install-config <path>`.
const PROTECTED_PATHS = [
  /CLAUDE\.md$/i,
  /\.claude\//,
  /\.env$/,
  /credentials\//,
  /\.ssh\//,
  /\.pem$/,
  /\/src\//,
  /\/channels\//,
  /\/dist\//,
  /package\.json$/,
  /package-lock\.json$/,
  /tsconfig\.json$/,
  /id_rsa/,
  /skills\/index\.json$/,
  /\/data\/skills\/.+\.md$/,   // skills must be managed via install_skill/remove_skill
  /\.mcp\.json$/,              // MCP servers must be managed via install_tool/remove_tool
  /cakeagent\.service$/,       // systemd unit
  /setup\.sh$/,                // provisioning script

  // Critical /etc/ paths — individual entries (replaces the blanket /etc/ block
  // so the agent can use install-config for non-critical /etc/ writes).
  /\/etc\/(shadow|passwd|group|gshadow)(-|$)/,
  /\/etc\/sudoers(\.d)?(\/|$)/,
  /\/etc\/ssh(\/|$)/,
  /\/etc\/pam\.d(\/|$)/,
  /\/etc\/security(\/|$)/,
  /\/etc\/ld\.so\.(preload|conf(\.d)?)(\/|$)/,
  /\/etc\/profile(\.d)?(\/|$)/,
  /\/etc\/bash\.bashrc$/,
  /\/etc\/environment$/,
  /\/etc\/cron\.(d|daily|hourly|monthly|weekly)(\/|$)/,
  /\/etc\/crontab$/,
  /\/etc\/hosts$/,
  /\/etc\/hostname$/,
  /\/etc\/resolv\.conf$/,
  /\/etc\/fstab$/,
  /\/etc\/nsswitch\.conf$/,
  /\/etc\/sysctl\.conf$/,
  /\/etc\/apt\/sources\.list$/,
  /\/etc\/apt\/trusted\.gpg/,
  /\/etc\/systemd\/system\/cakeagent/,
];

// Resolve a user-supplied path through symlinks and compare to the protected list.
// Returns the matching pattern if blocked, null otherwise. Used as a second layer
// after the cheap regex check so symlinked bypasses (e.g. groups/x -> /etc) are caught.
function resolvedPathBlocked(filePath: string, patterns: RegExp[]): RegExp | null {
  if (!filePath) return null;
  // Match against the raw path first (fast, covers non-existent targets of Write)
  const rawHit = patterns.find(p => p.test(filePath));
  if (rawHit) return rawHit;
  // For existing paths, also test the canonical path (defeats symlink traversal).
  try {
    if (existsSync(filePath)) {
      const real = realpathSync(filePath);
      const hit = patterns.find(p => p.test(real));
      if (hit) return hit;
    } else {
      // Target doesn't exist yet — canonicalise the parent to catch symlinked parents.
      const absolute = resolve(filePath);
      const parent = absolute.split(sep).slice(0, -1).join(sep) || sep;
      if (existsSync(parent)) {
        const realParent = realpathSync(parent);
        const realFull = join(realParent, absolute.split(sep).pop() ?? '');
        const hit = patterns.find(p => p.test(realFull));
        if (hit) return hit;
      }
    }
  } catch { /* realpath can fail on broken symlinks — fall through */ }
  return null;
}

export function createHooks(state: SharedState, groupsDir = './groups') {
  return {
    PreToolUse: [
      {
        matcher: '^Bash$',
        hooks: [async (input: HookInput) => {
          const ti = 'tool_input' in input ? input.tool_input as { command?: string } : null;
          const command: string = ti?.command ?? '';
          const normalized = normalizeCommand(command);
          const denied = BASH_DENY.find(p => p.test(normalized));
          if (denied) {
            logAudit('bash_denied', command.slice(0, 500));
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Command matches a blocked pattern',
              },
            };
          }
          logAudit('bash_allowed', command.slice(0, 200));
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }],
      },
      {
        matcher: '^Read$',
        hooks: [async (input: HookInput) => {
          const filePath: string = ('tool_input' in input ? (input.tool_input as { file_path?: string })?.file_path : '') ?? '';
          const blocked = resolvedPathBlocked(filePath, SENSITIVE_PATHS);
          if (blocked) {
            logAudit('read_denied', filePath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Sensitive file — access blocked',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }],
      },
      {
        matcher: '^Grep$',
        hooks: [async (input: HookInput) => {
          const searchPath: string = ('tool_input' in input ? (input.tool_input as { path?: string })?.path : '') ?? '';
          const blocked = resolvedPathBlocked(searchPath, SENSITIVE_PATHS);
          if (blocked) {
            logAudit('grep_denied', searchPath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Sensitive path — search blocked',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }],
      },
      {
        matcher: '^Glob$',
        hooks: [async (input: HookInput) => {
          const searchPath: string = ('tool_input' in input ? (input.tool_input as { path?: string })?.path : '') ?? '';
          const blocked = resolvedPathBlocked(searchPath, SENSITIVE_PATHS);
          if (blocked) {
            logAudit('glob_denied', searchPath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Sensitive directory — enumeration blocked',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }],
      },
      {
        matcher: '^(Write|Edit)$',
        hooks: [async (input: HookInput) => {
          const filePath: string = ('tool_input' in input ? (input.tool_input as { file_path?: string })?.file_path : '') ?? '';
          const blocked = resolvedPathBlocked(filePath, PROTECTED_PATHS);
          if (blocked) {
            logAudit('file_denied', filePath);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: 'Protected file — use update_memory tool instead',
              },
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }],
      },
    ],
    PostToolUse: [],
    SubagentStart: [
      {
        matcher: '.*',
        hooks: [async (input: HookInput) => {
          const si = input as { agent_type?: string; agent_id?: string };
          logAudit('subagent_start', `type=${si.agent_type ?? 'unknown'} id=${si.agent_id ?? 'unknown'}`);
          return {};
        }],
      },
    ],
    PreCompact: [
      {
        matcher: '.*',
        hooks: [async (input: HookInput) => {
          try {
            const sessionId = input.session_id ?? 'unknown';
            const groupFolder = state.currentGroupFolder ?? 'main';
            const chatId = state.currentChatId ?? '';
            const archiveDir = join(groupsDir, groupFolder, 'conversations');
            mkdirSync(archiveDir, { recursive: true });
            const date = new Date().toISOString().slice(0, 10);
            const filename = `${date}-${sessionId.slice(0, 8)}.md`;
            const archivePath = join(archiveDir, filename);

            // Dump actual recent transcript from SQLite so the archive is searchable,
            // not a placeholder. Bounded at 500 messages to avoid runaway files.
            let body = '';
            if (chatId) {
              const recent = getMessagesSince(chatId, 0, 500);
              body = [...recent].reverse().map(m => {
                const iso = new Date(m.timestamp).toISOString();
                return `### ${iso} — ${m.sender_name}\n${(m.content ?? '').slice(0, 4000)}`;
              }).join('\n\n');
            }
            const header = `# Conversation archived ${new Date().toISOString()}\nSession: ${sessionId}\nGroup: ${groupFolder}\nChat: ${chatId || '(unknown)'}\n\n`;
            writeFileSync(archivePath, header + (body || '_(no transcript available — chat unknown)_\n'));

            // Signal main loop to extract memory from the messages about to be lost.
            state.pendingMemoryExtraction = { groupFolder, chatId };
            logAudit('precompact', `Archived session ${sessionId} (${body.length} chars)`);
          } catch (err) {
            logAudit('precompact_error', (err as Error).message.slice(0, 200));
          }
          return {};
        }],
      },
    ],
  };
}
