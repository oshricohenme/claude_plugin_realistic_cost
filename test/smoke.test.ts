import { test } from "node:test"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strictEqual, ok } from "node:assert"
import {
  parseTranscript,
  estimateHours,
  computeCost,
  formatStatusLine,
  formatMarkdown,
  formatHtml,
  classifyDomain,
} from "../src/core/index.js"
import { renderTerminal } from "../src/cli/render.js"

// ---------------------------------------------------------------------------
// Helper: build a synthetic Claude Code transcript JSONL.
// Each line is a JSON message. Assistant messages carry tool_use blocks;
// we emit a few writes, reads, a grep, and a bash call + a thinking turn.
// ---------------------------------------------------------------------------

function assistantLine(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  withThinking = true,
): string {
  const content: unknown[] = []
  if (withThinking) content.push({ type: "thinking", thinking: "planning..." })
  content.push({ type: "text", text: "ok" })
  for (const t of toolUses) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input })
  }
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content } })
}

function userResultLine(id: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  })
}

function buildTranscript(): string {
  const lines: string[] = []
  lines.push(
    assistantLine([
      { id: "u1", name: "Glob", input: { pattern: "**/*.ts" } },
      { id: "u2", name: "Grep", input: { pattern: "TODO" } },
    ]),
  )
  lines.push(userResultLine("u1"))
  lines.push(userResultLine("u2"))
  lines.push(assistantLine([{ id: "u3", name: "Read", input: { filePath: "src/old.ts" } }]))
  lines.push(userResultLine("u3"))
  lines.push(
    assistantLine([
      {
        id: "u4",
        name: "Write",
        input: { filePath: "src/backend/api.ts", content: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n" },
      },
      {
        id: "u5",
        name: "Write",
        input: { filePath: "src/frontend/Button.tsx", content: "x\ny\nz\n" },
      },
      {
        id: "u6",
        name: "Write",
        input: { filePath: "docs/README.md", content: "# title\nbody\n" },
      },
    ]),
  )
  for (const id of ["u4", "u5", "u6"]) lines.push(userResultLine(id))
  lines.push(
    assistantLine([
      {
        id: "u7",
        name: "Edit",
        input: { filePath: "src/auth/login.ts", oldString: "old\n", newString: "new1\nnew2\nnew3\n" },
      },
      { id: "u8", name: "Bash", input: { command: "npm test" } },
    ]),
  )
  for (const id of ["u7", "u8"]) lines.push(userResultLine(id))
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("classifyDomain maps common extensions", () => {
  strictEqual(classifyDomain("src/api.ts"), "backend")
  strictEqual(classifyDomain("src/Button.tsx"), "frontend")
  strictEqual(classifyDomain("README.md"), "docs")
  strictEqual(classifyDomain("Dockerfile"), "config")
  strictEqual(classifyDomain("foo.test.ts"), "test")
  strictEqual(classifyDomain("logo.svg"), "design")
})

test("parseTranscript captures tool calls, writes, and flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-"))
  const tp = join(dir, "session.jsonl")
  writeFileSync(tp, buildTranscript())
  const stats = parseTranscript(tp)
  rmSync(dir, { recursive: true, force: true })

  strictEqual(stats.toolCalls.glob, 1)
  strictEqual(stats.toolCalls.grep, 1)
  strictEqual(stats.toolCalls.read, 1)
  strictEqual(stats.toolCalls.write, 3)
  strictEqual(stats.toolCalls.edit, 1)
  strictEqual(stats.toolCalls.bash, 1)
  ok(stats.thinkingTurns >= 4, "thinking turns counted")
  strictEqual(stats.fileWrites.length, 4) // 3 Write + 1 Edit
  ok(stats.touchesAuth, "auth flag detected from src/auth/login.ts")
})

test("estimateHours + computeCost produce a sane 11-role report", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-"))
  const tp = join(dir, "session.jsonl")
  writeFileSync(tp, buildTranscript())
  const stats = parseTranscript(tp)
  // Inject authoritative totals (as the status line would).
  stats.linesAdded = 50
  stats.linesRemoved = 5
  stats.durationMs = 120_000
  rmSync(dir, { recursive: true, force: true })

  const estimate = estimateHours(stats)
  ok(estimate.implementationHours > 0, "impl hours > 0")
  ok(estimate.discoveryHours > 0, "discovery hours > 0")

  const report = computeCost({ stats, estimate })
  strictEqual(report.roles.length, 11, "all 11 roles present")
  ok(report.totalCost > 0, "total cost > 0")
  ok(report.totalHours > 0)
  ok(report.calendar.manDays > 0)
  ok(report.calendar.humanReadable.length > 0)

  // formatters don't throw and produce non-empty output
  ok(formatStatusLine(report).length > 0)
  ok(renderTerminal(report).includes("TOTAL"))
  ok(formatMarkdown(report).includes("# Pre-AI"))
  ok(formatHtml(report).includes("<html"))
})

test("formatStatusLine is one line", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-"))
  const tp = join(dir, "session.jsonl")
  writeFileSync(tp, buildTranscript())
  const stats = parseTranscript(tp)
  const estimate = estimateHours(stats)
  const report = computeCost({ stats, estimate })
  rmSync(dir, { recursive: true, force: true })
  const line = formatStatusLine(report)
  strictEqual(line.split("\n").length, 1)
  ok(line.includes("Pre-AI"))
})
