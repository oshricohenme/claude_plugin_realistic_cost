# realistic-cost

> What would a 100% human-driven engineering team charge for this AI coding session?

[![CI](https://github.com/oshricohenme/claude_plugin_realistic_cost/actions/workflows/ci.yml/badge.svg)](https://github.com/oshricohenme/claude_plugin_realistic_cost/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)](package.json)

`realistic-cost` estimates the **fully-loaded cost and calendar effort** a
senior human engineering team would have needed to produce the work done in an
AI coding session — across **11 job functions**: Product Manager, Engineering
Manager, Designer, Backend, Frontend, Full-stack, QA, DevOps, Security, Data,
and Tech Writer.

It runs entirely on **session metadata** — line counts, tool-call counts,
thinking turns, and the session transcript. No git parsing, no source-code
diffing.

The output is formatted as a **receipt**: value-creation line items
(thinking, code comprehension, coding, design, review, QA), a management
overhead section, and a coordination tax — ending in a grand total.

```
════════════════════════════════════════════════════════════════════════
  Pre-AI Human Engineering Cost
  what a real team would charge
════════════════════════════════════════════════════════════════════════

  Management Overhead
  ──────────────────────────────────────────────────────────────────────
  Product Management          3.0h    $135/h       $405
  Engineering Management      3.0h    $155/h       $465
  ...

  Value Creation
  ──────────────────────────────────────────────────────────────────────
  Thinking                    2.1h    $112/h       $236
  Code Comprehension          1.5h    $112/h       $168
  Coding                      9.8h    $112/h     $1,098
  Peer Review                 3.4h    $115/h       $391
  ...

  Coordination Tax
  (meetings, emails, slack, status updates)
  ──────────────────────────────────────────────────────────────────────
  Meeting w/ Eng Manager      2.0h    $112/h       $224
  ...

  GRAND TOTAL                45.1h                $5,336
════════════════════════════════════════════════════════════════════════
  Effort: 5.6 man-days
  AI cost: $0.84
```

## How it works

```
status-line JSON (lines, duration, cost, transcript_path)
        │
        ▼
parse transcript JSONL  ──►  tool-call counts (Read/Write/Edit/Glob/Grep/Bash)
                              thinking turns + tokens
                              per-write file paths + line counts
        │
        ▼
classify write targets by file extension ──► domain (backend/frontend/docs/...)
        │
        ▼
estimate hours per domain (base lines/hr × complexity multipliers)
        │
        ▼
allocate to roles + apply overhead (review, EM, QA, PM, DevOps, Security, ...)
        │
        ▼
rates × hours ──► activity receipt (Value / Management / Coordination)
        │
        ▼
status line · terminal receipt · HTML · PDF · PNG
```

## Install

### Option A — interactive setup (recommended)

Clones this repo, builds the CLI, and installs into Claude Code and/or
[opencode](https://opencode.ai) with confirmation prompts:

```bash
git clone https://github.com/oshricohenme/claude_plugin_realistic_cost.git
cd claude_plugin_realistic_cost
./setup.sh
```

Restart Claude Code afterward.

### Option B — Claude Code only

```bash
./claude-code/install.sh
```

This builds the package, links the CLI globally, copies `statusline.sh`,
`print-cost.sh`, and the `/realistic-cost` skill into `~/.claude/`, and wires
the `statusLine` config into `~/.claude/settings.json` (created if absent).

### Option C — npm (once published)

```bash
npm install -g realistic-cost
```

Then add to `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "~/.claude/statusline.sh", "padding": 2 }
}
```

and copy `claude-code/statusline.sh` and `claude-code/skills/` into `~/.claude/`.

### Uninstall

```bash
./claude-code/uninstall.sh
```

Removes the copied files, cleans `settings.json` (with a timestamped backup),
and unlinks the global CLI.

## Usage

### Status line (automatic)

Once installed, the bottom bar of Claude Code shows a live one-line summary:

```
Pre-AI: $5,336 · 45.1h · 5.6 man-days | AI $0.84
```

The transcript parse is cached by file mtime+size (in the OS temp dir), so
refreshes stay cheap on long sessions.

### Stop hook (periodic terminal print)

`install.sh` also wires a Claude Code Stop hook (`print-cost.sh`) that prints
the one-line cost summary to the terminal **every 5th assistant turn**. If you
don't want terminal output, remove the `hooks.Stop` entry from
`~/.claude/settings.json` — the status line keeps working.

### Slash command

```
/realistic-cost              # full terminal receipt
/realistic-cost export pdf   # export to PDF (needs Chrome)
/realistic-cost export png   # export to PNG image
/realistic-cost export html  # export to HTML (always works)
```

### CLI (standalone)

```bash
# Auto-discovers the current session's transcript from ~/.claude/projects/
realistic-cost review
realistic-cost export --format pdf --out report.pdf

# Feed the status-line JSON on stdin (what statusline.sh does):
echo '{"cost":{"total_lines_added":120,...},"transcript_path":"..."}' | realistic-cost status

# Pin a specific transcript:
realistic-cost review --transcript ~/.claude/projects/.../abc.jsonl

# Full machine-readable report:
realistic-cost status --json
```

### opencode

The opencode integration adds a live cost footer in the sidebar and a
`/realistic-cost` review dialog. Install it via `./setup.sh` (option 2 or 3),
or manually:

```bash
cd opencode && bun install
opencode plugin "$(pwd)/.." --global   # registers opencode/plugins/realistic-cost-tui.tsx
```

## Configuration

### Hourly rates

Override any rate with a JSON file:

```json
{
  "currency": "EUR",
  "rates": { "backend": 130, "em": 170 }
}
```

```bash
realistic-cost review --rates my-rates.json
```

Only the roles you list are overridden; the rest keep their defaults. The
default rates live in `src/core/roles.ts` — the single source of truth.

### Model tuning

Every overhead multiplier and productivity assumption is a CLI flag, so you
can recalibrate the model without touching code:

```bash
realistic-cost review --review-overhead 0.45   # peer review at 45%
realistic-cost status  --qa-overhead 0.6       # QA overhead when no tests written
realistic-cost review --hours-per-day 6        # 6-hour man-days
```

| Flag | Default | Meaning |
|---|---|---|
| `--review-overhead` | 0.35 | peer-review overhead per engineering role |
| `--qa-overhead` | 0.50 | QA overhead when the session wrote no tests |
| `--qa-with-tests` | 0.35 | QA overhead when the session wrote tests |
| `--design-overhead` | 0.60 | design overhead of frontend+fullstack impl |
| `--pm-overhead` | 0.15 | PM overhead of impl hours (min 3h) |
| `--em-overhead` | 0.10 | EM overhead of impl hours (min 3h) |
| `--devops-deploy` | 0.15 | deploy/CI overhead of eng impl |
| `--security-sensitive` | 0.15 | security overhead when auth/data/infra touched |
| `--security-normal` | 0.05 | security overhead otherwise |
| `--techwriter-overhead` | 0.10 | changelog/docs overhead of impl |
| `--discovery-search-hours` | 0.25 | hours per glob+grep call |
| `--discovery-read-hours` | 0.15 | hours per file read |
| `--discovery-thinking-hours` | 0.10 | hours per thinking turn |
| `--hours-per-day` | 8 | productive hours per man-day |

The same knobs are available programmatically via `EstimateOptions` /
`CostOptions` — see `src/core/types.ts`.

## The cost model

> The canonical spec lives in `src/core/types.ts` and the implementation in
> `src/core/estimate.ts` + `src/core/cost.ts`. This section describes the
> model as implemented; if the two ever disagree, the code wins and this
> section is a bug.

### Roles & default hourly rates (senior, fully-loaded, USD)

| Role | Rate | Category |
|---|---|---|
| Product Manager | $135 | management |
| Engineering Manager | $155 | management |
| Product Designer | $120 | design |
| Senior Backend Engineer | $115 | engineering |
| Senior Frontend Engineer | $110 | engineering |
| Full-stack Engineer | $112 | engineering |
| QA Engineer | $90 | quality |
| DevOps / SRE | $130 | ops |
| Security Engineer | $155 | security |
| Data Engineer | $120 | data |
| Technical Writer | $80 | engineering |

### Productive lines/hour by domain

backend 12 · frontend 15 · fullstack 13 · docs 30 · config 8 · test 20 ·
other 10. Deletions are billed at 0.3× (faster to remove). Per write,
complexity multipliers apply: **new files** (full `Write`) ×1.5 and **large
single writes** (>100 lines) ×1.3, with the product capped at ×6. Design
assets are billed per-file (2h each).

### Reading & thinking time

Half of the session's read/search time is billed as engineering **code
comprehension** (added to implementation hours); thinking time is billed from
reasoning-token volume. The remainder is tracked as discovery hours.

### Overhead (derived from implementation hours)

- **Peer review**: each engineering role +35% of its impl hours
- **EM**: 10% of impl hours, min 3h (planning, standups, unblocking)
- **PM**: 15% of impl hours, min 3h (spec, acceptance, coordination)
- **QA**: 35% of impl if the session already wrote tests, else 50%
- **Designer**: +60% of frontend + fullstack impl, if frontend present
- **DevOps**: config/infra impl + 15% of eng impl for deploy/CI
- **Security**: 15% of impl if auth/data/infra files were touched, else 5%
- **Tech Writer**: docs impl + 10% of impl for changelogs/API docs

### The receipt (activity model)

The grand total is presented as three non-overlapping sections:

1. **Management overhead** — PM and EM, taken verbatim from the role
   estimate, so the receipt and the role table always agree.
2. **Value creation** — thinking, code comprehension, coding, design, peer
   review, QA, DevOps, security review.
3. **Coordination tax** — four overhead buckets (meetings with EM/PM/DevOps,
   issue management) totaling exactly **20% of the grand total**, reflecting
   the communication cost of a real team.

Thinking is billed from reasoning-token volume ($0.05/token — a deep
reasoning session maps to senior-engineer design time, not turn counts).

### Calendar

Effort is reported in **man-days** (total hours ÷ 8, configurable via
`CostOptions.productiveHoursPerDay`), humanized into hours / man-days /
weeks. This is total team effort, not elapsed wall-clock time.

## Limitations & methodology

- **This is an estimate, not an invoice.** The model is a set of heuristics
  (lines/hour by domain, overhead percentages, rate assumptions) — useful for
  order-of-magnitude framing, not budgeting.
- Session metadata is a **proxy** for work: a 1,000-line generated file is
  billed as if a human wrote 1,000 productive lines.
- **Subagent work is excluded.** Transcript lines flagged `isSidechain`
  (subagent/Task tool sessions) are not counted; work delegated to subagents
  is invisible to the estimate.
- Rates default to senior-level, fully-loaded US market rates. Override them
  for your market — the model is only as realistic as its rates.
- The opencode TUI plugin inlines a copy of the engine
  (`opencode/plugins/realistic-cost-tui.tsx`) so it can run dependency-free;
  the two must be kept in sync manually (see CONTRIBUTING.md).

## Output formats

- **Status line** — one line, ANSI color, for the bottom bar.
- **Terminal receipt** — full colored tables (kleur).
- **HTML** — self-contained, inline CSS, light/dark aware.
- **PDF / PNG** — via headless Chrome (auto-discovered; Edge/Brave/Chromium
  also work). Falls back to HTML if no browser is found.

## Project layout

```
src/
  core/           engine — no harness dependencies
    types.ts      contract + model spec (canonical)
    roles.ts      11 role definitions
    rates.ts      rate loading + merging
    transcript.ts parse JSONL + classify domains + detect flags
    estimate.ts   implementation + overhead hours per role
    cost.ts       activity receipt + calendar -> CostReport
    report.ts     formatters (statusline/markdown/html)
    index.ts      barrel
  cli/
    index.ts      commander CLI: status/review/export
    render.ts     kleur terminal receipt
    export.ts     HTML + PDF/PNG via headless Chrome
  bin/
    realistic-cost.ts
claude-code/
  install.sh      Claude Code installer (statusline + skill + Stop hook)
  uninstall.sh    clean removal
  statusline.sh   status-bar entry point
  print-cost.sh   Stop-hook cost printer (every 5th turn)
  skills/realistic-cost/SKILL.md
  settings.example.json
opencode/
  plugins/realistic-cost-tui.tsx   opencode TUI plugin (inlined engine)
test/
  smoke.test.ts    end-to-end smoke tests
  estimate.test.ts model math (options, multipliers, QA rates)
  cost.test.ts     receipt coherence (totals, coordination tax)
  rates.test.ts    rate merging safety
  transcript.test.ts parsing rules (line counts, sidechains)
  cli.test.ts      CLI wiring (validation, version, cache)
```

## Development

```bash
npm install
npm run dev        # run the CLI from source
npm test           # node:test + tsx (requires Node 20.6+)
npm run typecheck  # strict tsc
npm run build      # compile to dist/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the model-change checklist and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
