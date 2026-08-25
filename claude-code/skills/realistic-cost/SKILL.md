---
name: realistic-cost
description: Show what a 100% human-driven engineering team would have cost for this session. Use /realistic-cost for the full receipt (line items, coordination tax, grand total, per-role breakdown), or /realistic-cost export pdf|png|html|md to export it.
argument-hint: "[review | export pdf|png|html|md]"
allowed-tools: Bash(realistic-cost:*)
---

# /realistic-cost — Pre-AI Human Engineering Cost

Estimates what a fully human-driven engineering team (PM, EM, designer,
backend, frontend, full-stack, QA, DevOps, security, data engineer, tech
writer) would have cost to produce the work in the current session.

It reads the session transcript and status-line metadata — lines added and
removed, duration, tool-call counts, thinking volume. No source-code diffing.

## Steps

1. Read `$ARGUMENTS`:
   - empty or `review` → run a **review**
   - starts with `export` → run an **export** with the given format (default `html`)

2. Run the matching command. The binary auto-discovers the current session's
   transcript from `~/.claude/projects/`, so no path is needed.

### Review (default)

```bash
realistic-cost review
```

Print the receipt it outputs **verbatim, inside a code block**. The output has
four parts, in this order:

1. **Management Overhead** — Product Management, Engineering Management.
2. **Value Creation** — Thinking, Code Comprehension, Coding, Design, Peer
   Review, QA & Testing, DevOps & Infra, Security Review. Line items with no
   corresponding work are omitted rather than shown as zero.
3. **Coordination Tax** — meetings with the EM/PM/DevOps and issue management,
   totalling 20% of the grand total.
4. **Grand Total**, then effort in man-days, the actual AI cost, and a
   **Who Would Have Done It** table breaking the same work down by role.

Then add one or two plain-language sentences on the headline numbers: total
cost and man-days of effort.

Do not describe the numbers as a quote or an invoice — they are a heuristic
estimate for order-of-magnitude framing. If the user asks how a figure was
derived, the model is documented in the project README under "The cost model".

### Export

Parse the format from the arguments: `pdf`, `png`, `html`, or `md`
(default `html`).

```bash
realistic-cost export --format <pdf|png|html|md> [--out <path>]
```

- `html` and `md` always work.
- `pdf` and `png` shell out to headless Chrome. If no browser is found the
  command writes HTML instead and says so — relay that path and mention that
  installing Chrome enables PDF/PNG.

Report the output file path when it finishes.

## Notes

- This command only runs `realistic-cost`. Do not write code or edit files.
- If `realistic-cost` is not on PATH, tell the user to run the installer
  (`./claude-code/install.sh`) rather than trying to fetch it at runtime.
