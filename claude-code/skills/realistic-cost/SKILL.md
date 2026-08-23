---
description: Show what a 100% human-driven engineering team would cost for this session. Use /realistic-cost to see the full receipt (line items, coordination tax, grand total), or /realistic-cost export pdf|png|html to export.
argument-hint: "[review | export pdf|png|html]"
allowed-tools: Bash(realistic-cost:*), Bash(npx realistic-cost:*), Read(~/.claude/projects/**)
---

# /realistic-cost — Pre-AI Human Engineering Cost

You are invoking the `realistic-cost` tool, which estimates what a fully
human-driven engineering team (PM, EM, designer, backend, frontend, fullstack,
QA, DevOps, security, data, tech writer) would cost to produce the work in the
current Claude Code session.

The tool reads the session transcript and the status-line metadata (lines
added/removed, duration, tool-call counts) — **no source-code diffing**.

The output is formatted as a **receipt**: direct work line items (Speccing &
Research, Thinking, Code Comprehension, Coding, Design, Documentation) with a
subtotal, then Coordination Tax (Peer Review, Management, QA, DevOps, Security)
with its own subtotal and overhead percentage, and a bold Grand Total.

## Steps

1. Determine the invocation. The user's arguments are in `$ARGUMENTS`.
   - If `$ARGUMENTS` is empty or `review`: run a **review**.
   - If it starts with `export`: run an **export** with the format (default `html`).

2. Run the matching command. The binary auto-discovers the current session's
   transcript from `~/.claude/projects/`, so no path is needed.

### Review (default)

```bash
realistic-cost review
```

If `realistic-cost` is not on PATH, try `npx --yes realistic-cost review`.

Print the full colored receipt it outputs to the terminal, verbatim, inside a
code block so the user sees the line items and totals. Then give a 1–2 sentence
plain-language summary of the headline numbers (total cost, man-days effort).

### Export

Parse the format from the arguments: `pdf`, `png`, or `html` (default `html`).

```bash
realistic-cost export --format <pdf|png|html> [--out <path>]
```

- For `pdf`/`png`, the tool shells out to headless Chrome. If Chrome is not
  installed it gracefully degrades to writing an HTML file and tells you the
  path — relay that path and note to the user that installing Chrome enables
  PDF/PNG.
- After the export, tell the user the output file path.

3. Do not write any code yourself — this command only runs `realistic-cost`.
