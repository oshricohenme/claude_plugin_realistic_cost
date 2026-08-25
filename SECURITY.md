# Security Policy

## Supported versions

The latest released minor version receives security fixes.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/oshricohenme/claude_plugin_realistic_cost/security/advisories/new)
rather than opening a public issue. You should get an initial response within
seven days.

## What this tool touches

`realistic-cost` is a local CLI. It is useful to know what it does and does not
do when assessing risk:

- **Reads** session transcript JSONL files under `~/.claude/projects/`, and any
  path passed via `--transcript`. Transcripts can contain source code and
  prompt text.
- **Writes** a parsed-stats cache to a private per-user directory (mode 0700)
  inside the system temp directory, and export files to paths you choose.
- **Modifies** `~/.claude/settings.json` only when you run an installer, and
  always writes a timestamped backup first. Permission entries are added only
  with the explicit `--with-permissions` flag.
- **Executes** headless Chrome, and only for `--format pdf|png`. The Chrome
  sandbox is left enabled except when running as root, where Chrome refuses to
  start otherwise.
- **Sends nothing over the network.** There is no telemetry, no update check,
  and no runtime package resolution.
