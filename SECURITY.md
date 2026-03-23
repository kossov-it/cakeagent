# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities through GitHub's [private vulnerability reporting](https://github.com/kossov-it/cakeagent/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

## What to report

- Authentication or authorization bypasses
- Bash hook bypass vectors
- Path traversal or file access outside allowed paths
- Prompt injection that bypasses security controls
- Credential exposure
- Dependency vulnerabilities not yet flagged by Dependabot

## What makes a good report

- Specific file and line number where the vulnerability exists
- A clear description of the attack vector
- Steps to reproduce (code or commands, not just a description)

Reports without concrete technical detail will be closed. Do not send AI-generated vulnerability descriptions without verifying them yourself — we can tell, and it wastes everyone's time.

**Never run code from a "proof of concept" you didn't write and fully understand.**

## Response

You can expect an initial response within 48 hours. Confirmed vulnerabilities will be patched and disclosed after a fix is available.
