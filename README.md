# realistic-cost

> What would a 100% human-driven engineering team have charged for this AI coding session?

[![CI](https://github.com/oshricohenme/claude_plugin_realistic_cost/actions/workflows/ci.yml/badge.svg)](https://github.com/oshricohenme/claude_plugin_realistic_cost/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.6-brightgreen)](package.json)

`realistic-cost` prices an AI coding session the way an agency would have
invoiced it: fully-loaded hours across eleven job functions — Product Manager,
Engineering Manager, Product Designer, Backend, Frontend, Full-stack, QA,
DevOps/SRE, Security, Data Engineer, Technical Writer — plus the management and
coordination overhead a real team carries.

It runs on **session metadata only**: line counts, tool-call counts, reasoning
volume, and the session transcript. No git parsing, no source-code diffing,
nothing leaves your machine.

Works with **Claude Code** (status line, Stop hook, `/realistic-cost` skill) and
**opencode** (live sidebar footer, `/realistic-cost` dialog).

```
════════════════════════════════════════════════════════════════════════
  Pre-AI Human Engineering Cost
  what a real team would charge
════════════════════════════════════════════════════════════════════════

  LINE ITEM                                QTY      RATE       AMOUNT
  ──────────────────────────────────────────────────────────────────────
  Management Overhead
  ──────────────────────────────────────────────────────────────────────
  Product Management                      7.0h    $135/h         $949
  Engineering Management                  4.7h    $155/h         $726
  ──────────────────────────────────────────────────────────────────────
  Management Overhead Subtotal           11.7h                 $1,675

  Value Creation
  ──────────────────────────────────────────────────────────────────────
  Coding                                 46.2h    $112/h       $5,151
  Peer Review                            14.8h    $114/h       $1,689
  QA & Testing                           16.4h     $90/h       $1,476
  Security Review                         7.0h    $155/h       $1,089
  DevOps & Infra                          6.4h    $130/h         $826
  Design                                  5.6h    $120/h         $673
  Thinking                                1.8h    $112/h         $200
  Code Comprehension                      0.7h    $112/h          $78
  ──────────────────────────────────────────────────────────────────────
  Value Creation Subtotal                98.9h                $11,183

  Coordination Tax
  (meetings, emails, slack, status updates)
  ──────────────────────────────────────────────────────────────────────
    Meeting w/ Eng Manager                7.2h    $112/h         $804
    Meeting w/ PM                         7.2h    $112/h         $804
    Meeting w/ DevOps                     7.2h    $112/h         $804
    Issue Management                      7.2h    $112/h         $804
  ──────────────────────────────────────────────────────────────────────
  Coordination Tax Total                 28.8h                 $3,214
    (20% of grand total is coordination overhead)

════════════════════════════════════════════════════════════════════════
  GRAND TOTAL                           139.4h                $16,072
════════════════════════════════════════════════════════════════════════

  Effort: 17.4 man-days · 3 weeks, 2 man-days
  AI cost: $0.84
```

---

## Table of contents

- [Requirements](#requirements)
- [Install — Claude Code plugin marketplace](#install--claude-code-plugin-marketplace)
- [Install — Claude Code](#install--claude-code)
- [Install — opencode](#install--opencode)
- [Install — CLI only](#install--cli-only)
- [Uninstall](#uninstall)
- [Usage](#usage)
- [Configuration](#configuration)
- [The cost model](#the-cost-model)
- [Limitations](#limitations)
- [Development](#development)
- [Author](#author)
- [License](#license)

---

## Requirements

|                       |                                                        |
| --------------------- | ------------------------------------------------------ |
| **Node.js**           | 20.6 or newer (`node --version`)                       |
| **Claude Code**       | any recent version, for the status line and skill      |
| **opencode**          | 1.4.3+, plus [Bun](https://bun.sh), for the TUI plugin |
| **Chrome / Chromium** | optional — only for `--format pdf` and `--format png`  |

Everything else is bundled. The tool makes no network requests.

---

## Install — Claude Code plugin marketplace

The repository is its own Claude Code plugin marketplace. Two commands, no
clone:

```
/plugin marketplace add oshricohenme/claude_plugin_realistic_cost
/plugin install realistic-cost@pre-ai-dev-cost-receipt
```

Then install the engine the plugin drives, once:

```bash
npm install -g pre_ai_dev_cost_receipt
```

You get the `/realistic-cost` skill and the Stop hook that prints the cost line
every fifth assistant turn.

> **The status line is not part of the plugin.** Claude Code plugins cannot
> declare a `statusLine`, so the bottom-bar readout still has to be wired into
> your own settings. Add this to `~/.claude/settings.json` — or run
> [`./claude-code/install.sh`](#install--claude-code), which does it for you and
> backs the file up first:
>
> ```json
> {
>   "statusLine": {
>     "type": "command",
>     "command": "~/.claude/statusline.sh",
>     "padding": 2
>   }
> }
> ```

If the CLI is missing, the Stop hook says so once per session rather than
failing silently. The status line and the hook deliberately never fall back to
`npx`: both run on a hot path, and resolving a package from the registry there
would be slow _and_ a supply-chain risk.

<details>
<summary><b>What the plugin registers</b></summary>

| Manifest                          | Registers                                     |
| --------------------------------- | --------------------------------------------- |
| `.claude-plugin/marketplace.json` | the `pre-ai-dev-cost-receipt` marketplace     |
| `.claude-plugin/plugin.json`      | the `realistic-cost` plugin (v0.4.0, MIT)     |
| `claude-code/skills/`             | the `/realistic-cost` skill                   |
| `claude-code/hooks/hooks.json`    | the `Stop` hook → `claude-code/print-cost.sh` |

It writes nothing to `~/.claude/settings.json` and adds no permission entries.

</details>

---

## Install — Claude Code

The scripted install, for the full experience **including the status line**.
Adds a live status line, a `/realistic-cost` slash command, and a Stop hook that
prints the cost summary every fifth assistant turn.

```bash
git clone https://github.com/oshricohenme/claude_plugin_realistic_cost.git
cd claude_plugin_realistic_cost
./claude-code/install.sh
```

Then **restart Claude Code**. The bottom bar will show:

```
Pre-AI: $16,072 · 139.4h · 17.4 man-days | AI $0.84
```

<details>
<summary><b>What the installer changes</b></summary>

| Path                               | Change                                       |
| ---------------------------------- | -------------------------------------------- |
| `~/.claude/statusline.sh`          | installed (status-bar entry point)           |
| `~/.claude/print-cost.sh`          | installed (Stop-hook cost printer)           |
| `~/.claude/skills/realistic-cost/` | installed (`/realistic-cost` command)        |
| `~/.claude/settings.json`          | `statusLine` set; our Stop hook **appended** |
| global npm prefix                  | `realistic-cost` linked onto your `PATH`     |

The installer is careful with `settings.json`:

- it writes a **timestamped backup on every run**, not just the first;
- it **appends** to `hooks.Stop` rather than replacing it, so hooks belonging to
  other tools survive;
- it **remembers any `statusLine` it displaces** and restores it on uninstall;
- it adds **no permission entries** unless you pass `--with-permissions`.

</details>

**Optional — pre-approve the commands** so Claude Code doesn't prompt for them:

```bash
./claude-code/install.sh --with-permissions
```

This adds `Bash(realistic-cost:*)` and the two script paths to
`permissions.allow` in `~/.claude/settings.json`. It is off by default because
editing someone's permission list should be a deliberate choice.

**Manual wiring** — if you'd rather not run the installer, install the CLI
([below](#install--cli-only)), copy `claude-code/statusline.sh`,
`claude-code/print-cost.sh` and `claude-code/skills/` into `~/.claude/`, then
merge `claude-code/settings.example.json` into your `~/.claude/settings.json`.

---

## Install — opencode

Adds a live cost footer to the sidebar and a `/realistic-cost` receipt dialog.

```bash
git clone https://github.com/oshricohenme/claude_plugin_realistic_cost.git
cd claude_plugin_realistic_cost
./setup.sh --target opencode
```

Then **restart opencode**.

<details>
<summary><b>Manual install</b></summary>

```bash
# 1. Build the engine (the plugin imports it — it is not a second copy)
npm install && npm run build

# 2. Install the plugin's own dependencies
cd opencode && bun install && cd ..

# 3. Register the TUI plugin
opencode plugin "$(pwd)/opencode" --global

# 4. Install the slash command
mkdir -p ~/.config/opencode/skills
cp -R opencode/skills/realistic-cost ~/.config/opencode/skills/
```

</details>

> **Note** — in opencode, read the numbers from the **sidebar footer** or the
> `/realistic-cost` dialog. Those come from live opencode session state. The
> standalone CLI reads Claude Code transcripts from `~/.claude/projects/` and
> will report near-zero for an opencode session unless you point it at a
> transcript with `--transcript`.

**Both harnesses at once:**

```bash
./setup.sh                     # interactive, confirms each step
./setup.sh --target both --yes # non-interactive
```

---

## Install — CLI only

```bash
npm install -g pre_ai_dev_cost_receipt
realistic-cost review
```

Or from a clone, without touching any harness config:

```bash
npm install && npm run build && npm link
```

---

## Uninstall

```bash
./claude-code/uninstall.sh                              # Claude Code
opencode plugin remove "$(pwd)/opencode"                # opencode
```

The Claude Code uninstaller restores the `statusLine` you had before installing,
removes only its own Stop-hook entry, drops its permission entries, clears its
temp files, and unlinks the CLI. It backs up `settings.json` before touching it.

---

## Usage

### Status line (Claude Code, automatic)

```
Pre-AI: $16,072 · 139.4h · 17.4 man-days | AI $0.84
```

The transcript parse is cached by file mtime + size in a private per-user temp
directory, so refreshes stay cheap on long sessions.

### Slash command

```
/realistic-cost                 # full receipt
/realistic-cost export pdf      # export to PDF  (needs Chrome)
/realistic-cost export png      # export to PNG  (needs Chrome)
/realistic-cost export html     # export to HTML (always works)
/realistic-cost export md       # export to Markdown
```

### CLI

```bash
# Auto-discovers the current project's transcript under ~/.claude/projects/
realistic-cost review

# A specific transcript
realistic-cost review --transcript ~/.claude/projects/<project>/<session>.jsonl

# Machine-readable
realistic-cost status --json

# Export
realistic-cost export --format pdf --out report.pdf

# Status-line JSON on stdin (what statusline.sh does)
echo '{"transcript_path":"…","cost":{"total_lines_added":120}}' | realistic-cost status
```

| Command  | Output                                                    |
| -------- | --------------------------------------------------------- |
| `status` | one line, for a status bar (`--json` for the full report) |
| `review` | the full coloured receipt                                 |
| `export` | `html` \| `md` \| `pdf` \| `png`                          |

---

## Configuration

### Hourly rates and currency

```json
{
  "currency": "EUR",
  "rates": { "backend": 130, "em": 170 }
}
```

```bash
realistic-cost review --rates my-rates.json
```

Only the roles you list are overridden; the rest keep their defaults. Unknown
role names and non-positive rates are reported on stderr rather than silently
ignored. `currency` accepts any ISO 4217 code and changes how amounts are
formatted — it does **not** convert them, so set rates in that currency too.

### Model tuning

Every multiplier and productivity assumption is a CLI flag, so you can
recalibrate without touching code:

| Flag                         | Default | Meaning                                        |
| ---------------------------- | ------- | ---------------------------------------------- |
| `--review-overhead`          | 0.35    | peer-review overhead per engineering role      |
| `--qa-overhead`              | 0.50    | QA overhead when the session wrote no tests    |
| `--qa-with-tests`            | 0.35    | QA overhead when the session wrote tests       |
| `--design-overhead`          | 0.60    | design overhead of frontend + full-stack impl  |
| `--pm-overhead`              | 0.15    | PM overhead of impl hours (min 3h)             |
| `--em-overhead`              | 0.10    | EM overhead of impl hours (min 3h)             |
| `--devops-deploy`            | 0.15    | deploy/CI overhead of engineering impl         |
| `--security-sensitive`       | 0.15    | security overhead when auth/data/infra touched |
| `--security-normal`          | 0.05    | security overhead otherwise                    |
| `--techwriter-overhead`      | 0.10    | changelog/docs overhead of impl                |
| `--thinking-cost-per-token`  | 0.05    | USD per reasoning token billed as design time  |
| `--discovery-search-hours`   | 0.25    | hours per glob/grep call                       |
| `--discovery-read-hours`     | 0.15    | hours per file read                            |
| `--discovery-thinking-hours` | 0.10    | hours per thinking turn                        |
| `--hours-per-day`            | 8       | productive hours per man-day                   |

```bash
realistic-cost review --review-overhead 0.45 --hours-per-day 6
```

The same knobs are available programmatically via `EstimateOptions` /
`CostOptions` — see `src/core/types.ts`.

### Programmatic use

```ts
import { parseTranscript, estimateHours, computeCost, formatMarkdown } from "pre_ai_dev_cost_receipt/core"

const stats = parseTranscript("/path/to/session.jsonl")
const report = computeCost({ stats, estimate: estimateHours(stats) })
console.log(formatMarkdown(report))
```

---

## The cost model

> The canonical spec is the header comment in `src/core/types.ts`; the
> implementation is `src/core/estimate.ts` + `src/core/cost.ts`. If this section
> and the code disagree, the code wins and this section is a bug.

### Roles and default rates (senior, fully-loaded, USD)

| Role                     | Rate | Gets work from                                     |
| ------------------------ | ---- | -------------------------------------------------- |
| Product Manager          | $135 | 15% of impl hours (min 3h)                         |
| Engineering Manager      | $155 | 10% of impl hours (min 3h)                         |
| Product Designer         | $120 | design assets + 60% of FE/FS impl                  |
| Senior Backend Engineer  | $115 | backend files, `other` files, half of full-stack   |
| Senior Frontend Engineer | $110 | frontend files, half of full-stack                 |
| Full-stack Engineer      | $112 | route/action files, when only one stack is present |
| QA Engineer              | $90  | test files + 35–50% of impl                        |
| DevOps / SRE             | $130 | config & infra files + 15% of engineering impl     |
| Security Engineer        | $155 | 5% of impl, or 15% if auth/data/infra was touched  |
| Data Engineer            | $120 | migrations, schema, SQL                            |
| Technical Writer         | $80  | docs files + 10% of impl                           |

### How hours are derived

1. **Classify** every `Write`/`Edit`/`MultiEdit` target by path into one of:
   `backend`, `frontend`, `fullstack`, `data`, `docs`, `config`, `test`,
   `design`, `other`.
2. **Convert lines to hours** at a productive rate per domain — backend 12,
   frontend 15, full-stack 13, data 10, docs 30, config 8, test 20, other 10
   lines/hour. Deletions bill at 0.3×. Per write, a new file (a full `Write`)
   is ×1.5 and a single write over 100 lines is ×1.3. Design assets bill flat
   at 2h each.
3. **Add comprehension time.** Half the session's read/search time bills to
   engineers as code comprehension; the rest is tracked as discovery.
4. **Apply overhead** per the table above.
5. **Bill thinking** from reasoning-token volume at `$0.05/token` — a deep
   reasoning session maps to senior design time, not to turn counts.

### The receipt

Three non-overlapping sections:

1. **Management overhead** — PM and EM, taken verbatim from the role estimate,
   so the receipt and the role table always agree.
2. **Value creation** — thinking, comprehension, coding, design, peer review,
   QA, DevOps, security review.
3. **Coordination tax** — four buckets totalling exactly 20% of the grand total.

so `grandTotal = (valueCreation + management) / 0.80`.

The per-role table printed below the receipt is a _different view of the same
work_. It excludes the coordination tax — which no single role owns — so it
sums to less than the grand total by design.

Effort is reported in **man-days** (total hours ÷ 8, configurable). That is
total team effort, not elapsed calendar time.

---

## Limitations

Read this before quoting a number at anyone.

- **This is an estimate, not an invoice.** The model is a set of heuristics.
  It is useful for order-of-magnitude framing and nothing more.
- **Metadata is a proxy for work.** A 1,000-line generated file bills as if a
  human wrote 1,000 productive lines. Line count is not value.
- **Subagent work is excluded.** Transcript lines flagged `isSidechain` are not
  counted, so work delegated to subagents is invisible to the estimate.
- **Rates are senior-level US market defaults.** The model is only as realistic
  as the rates you give it — override them for your market.
- **Thinking is billed per reasoning token**, which makes
  `--thinking-cost-per-token` the single most influential knob in the model.
  Turn it down if reasoning-heavy sessions look inflated to you.
- **opencode reports per-file diffs**, not individual edits, so its per-write
  complexity multipliers are coarser than Claude Code's.

Found a case where the numbers are clearly wrong?
[Open a model-feedback issue](https://github.com/oshricohenme/claude_plugin_realistic_cost/issues/new?template=model_feedback.yml)
— counter-examples are the best way to improve this.

---

## Development

```bash
npm install
npm run dev        # run the CLI from TypeScript source
npm test           # node:test + tsx
npm run typecheck  # strict tsc, including the opencode plugin
npm run lint       # eslint
npm run check      # typecheck + lint + format + test (what CI runs)
npm run build      # compile to dist/
```

```
src/
  core/           the engine — no harness dependencies
    types.ts      contract + model spec (canonical)
    roles.ts      role definitions and default rates
    rates.ts      rate loading and merging
    transcript.ts JSONL parsing, domain classification, sensitivity flags
    estimate.ts   implementation + overhead hours per role
    cost.ts       activity receipt + calendar -> CostReport
    report.ts     formatters (status line, markdown, HTML) + money formatting
  cli/            commander CLI: status / review / export
  bin/            executable entry point
claude-code/
  install.sh, uninstall.sh   installers
  configure-settings.mjs     the only code that edits settings.json
  statusline.sh              status-bar entry point
  print-cost.sh              Stop-hook cost printer
  skills/realistic-cost/     /realistic-cost slash command
opencode/
  plugins/realistic-cost-tui.tsx   TUI plugin — imports the engine, no copy
  skills/realistic-cost/           /realistic-cost slash command
test/                              64 tests: model math, parsing, CLI, installer
```

The opencode plugin **imports** `pre_ai_dev_cost_receipt/core` rather than inlining a
copy, so both harnesses are guaranteed to produce the same number for the same
session.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the model-change checklist,
[CHANGELOG.md](CHANGELOG.md) for release history, and
[SECURITY.md](SECURITY.md) for what the tool reads, writes, and executes.

---

## Author

**Oshri Cohen**

[oshricohen.me](https://oshricohen.me) ·
[LinkedIn](https://www.linkedin.com/in/oshricohen) ·
[GitHub](https://github.com/oshricohenme)

Questions about the cost model, or think a rate is wrong for your market?
[Open an issue](https://github.com/oshricohenme/claude_plugin_realistic_cost/issues)
— the model is a heuristic and it improves on feedback.

---

## License

[MIT](LICENSE) © Oshri Cohen
