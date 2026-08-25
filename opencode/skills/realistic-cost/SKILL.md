---
name: realistic-cost
description: Show what a 100% human-driven engineering team would have cost for this session — the full receipt with line items, coordination tax, grand total and per-role breakdown, or an export to pdf/png/html/md.
---

# /realistic-cost — Pre-AI Human Engineering Cost

Estimates what a fully human-driven engineering team (PM, EM, designer,
backend, frontend, full-stack, QA, DevOps, security, data engineer, tech
writer) would have cost to produce the work in the current session.

It reads session metadata — files changed, lines added and removed, tool-call
counts, reasoning volume, duration. No source-code diffing.

## Two ways to see the numbers in opencode

**The TUI plugin is the accurate one.** It reads live opencode session state,
so it always reflects the session you are actually in:

- the sidebar footer shows a running total
- the `/realistic-cost` command (registered by the plugin) opens the full
  receipt dialog

**The CLI** (`realistic-cost review`) reads Claude Code transcripts from
`~/.claude/projects/`. In an opencode session there is usually no such
transcript, and it will report a near-zero result. Use the CLI here only when
the user explicitly wants to price a Claude Code session or passes an explicit
`--transcript <path>`.

## Steps

1. Read the arguments after `/realistic-cost`:
   - empty or `review` → show the **review**
   - `export` followed by `pdf` | `png` | `html` | `md` (default `html`) → run an **export**

2. For a review, prefer telling the user to open the plugin dialog
   (`/realistic-cost` in the TUI) or read the sidebar footer. Only shell out to
   the CLI when they want a specific transcript priced:

```bash
realistic-cost review --transcript <path-to-session.jsonl>
```

Print whatever receipt you get verbatim, inside a code block. The receipt has
four parts: **Management Overhead**, **Value Creation**, **Coordination Tax**
(20% of the grand total), and the **Grand Total** followed by effort in
man-days and a per-role breakdown. Then summarise the headline numbers — total
cost and man-days — in one or two sentences.

Do not present the figures as a quote or an invoice; they are a heuristic
estimate for order-of-magnitude framing.

### Export

```bash
realistic-cost export --format <pdf|png|html|md> [--out <path>]
```

- `html` and `md` always work.
- `pdf` and `png` shell out to headless Chrome. Without a browser the command
  writes HTML instead and says so — relay that path and mention that
  installing Chrome enables PDF/PNG.

Report the output file path when it finishes.

## Notes

- This command only runs `realistic-cost`. Do not write code or edit files.
- If `realistic-cost` is not on PATH, tell the user to run `./setup.sh` from
  the repo rather than fetching it at runtime.
