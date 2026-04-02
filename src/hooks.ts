import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { SharedState } from './types.js';
import { logAudit } from './store.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Normalize command for pattern matching — strip quotes to prevent bypass
function normalizeCommand(cmd: string): string {
  return cmd.replace(/["'\\]/g, '');
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
  /\/etc\/(shadow|passwd|sudoers)/,
  /\/etc\/ssh\//,
  /\/etc\/hosts\b/,
  /\/etc\/resolv\.conf\b/,
  /\/etc\/hostname\b/,
  /\/etc\/fstab\b/,
  /\/etc\/sysctl\.conf\b/,
  /\/etc\/apt\/sources\.list(?!\.d)/,
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

  // Enhanced validators ported from Claude Code's bashSecurity.ts
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
          const blocked = SENSITIVE_PATHS.find(p => p.test(filePath));
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
          const blocked = SENSITIVE_PATHS.find(p => p.test(searchPath));
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
          const blocked = SENSITIVE_PATHS.find(p => p.test(searchPath));
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
          const blocked = PROTECTED_PATHS.find(p => p.test(filePath));
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
