---
name: realistic-cost
description: "Show what a 100% human-driven engineering team would cost for this session. Use /realistic-cost to see the full receipt (line items, coordination tax, grand total), or /realistic-cost export pdf|png|html to export the report."
---

# /realistic-cost — Pre-AI Human Engineering Cost

You are invoking the `realistic-cost` tool, which estimates what a fully
human-driven engineering team (PM, EM, designer, backend, frontend, fullstack,
QA, DevOps, security, data, tech writer) would cost to produce the work in the
current session.

The tool reads session metadata (tool-call counts, lines added/removed,
duration, thinking turns) — **no source-code diffing**.

The output is formatted as a **receipt** with three sections, each with its own
subtotal:

1. **Management Overhead** — Product Management, Engineering Management.
2. **Value Creation** — Thinking, Code Comprehension, Coding, Design, Peer
   Review, QA & Testing, DevOps & Infra, Security Review.
3. **Coordination Tax** — meetings with the EM, PM and DevOps, plus issue
   management. Its subtotal also shows what percentage of the grand total is
   coordination overhead.

A bold Grand Total closes the receipt, followed by the effort in man-days.

Value Creation and Coordination Tax line items are omitted when they come out
at zero, but Management Overhead is always billed — it stands for the planning
that precedes the session — so a session that produced no code still shows a
non-zero total.

## Steps

1. Parse the user's arguments after `/realistic-cost`:
   - Empty or `review` → run a **review**.
   - `export` followed by `pdf` | `png` | `html` (default `html`) → run an **export**.

2. Run the matching command via the Bash tool. The binary is on PATH after
   `setup.sh` has been run.

### Review (default)

```bash
realistic-cost review
```

If `realistic-cost` is not on PATH, fall back to `npx --yes realistic-cost review`.

- The tool auto-discovers the current session's transcript. In opencode it
  looks under `~/.claude/projects/`; if none is found it reports a $0 / 0h
  no-op rather than crashing.
- If auto-discovery finds nothing, you may pass a transcript path explicitly:
  `realistic-cost review --dir <project-dir>` or pipe status-line JSON via
  stdin: `echo '<json>' | realistic-cost status`.

Print the full colored receipt it outputs to the terminal, verbatim, inside a
code block so the user sees the line items and totals. Then give a 1–2 sentence
plain-language summary of the headline numbers (total cost, man-days effort).

### Export

```bash
realistic-cost export --format <pdf|png|html> [--out <path>]
```

- For `pdf`/`png`, the tool shells out to headless Chrome. If Chrome is not
  installed it gracefully degrades to writing an HTML file and tells you the
  path — relay that path and note to the user that installing Chrome enables
  PDF/PNG.
- After the export, tell the user the output file path.

3. Do not write any code yourself — this command only runs `realistic-cost`.
