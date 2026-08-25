import { test } from "node:test"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strictEqual, ok } from "node:assert"
import { parseTranscript, emptyStats, parseStatusLineStdin, classifyDomain } from "../src/core/index.js"

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

function withTempTranscript(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rc-t-"))
  const tp = join(dir, "session.jsonl")
  writeFileSync(tp, content, "utf8")
  try {
    fn(tp)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const assistantWrite = (path: string, content: string, id = "u1") =>
  ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Write", input: { filePath: path, content } }] } })

// ---------------------------------------------------------------------------
// lineCount — regression for the trailing-newline off-by-one
// ---------------------------------------------------------------------------

test("Write content lines are counted without the trailing-newline phantom line", () => {
  withTempTranscript(jsonl([assistantWrite("src/a.ts", "a\nb\nc\n")]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 3, '"a\\nb\\nc\\n" is 3 lines')
    strictEqual(s.linesAdded, 3)
  })
})

test("single-line content without trailing newline counts as 1", () => {
  withTempTranscript(jsonl([assistantWrite("src/a.ts", "a")]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 1)
  })
})

test("empty Write content counts as 0 lines", () => {
  withTempTranscript(jsonl([assistantWrite("src/a.ts", "")]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 0)
  })
})

// ---------------------------------------------------------------------------
// Edit / MultiEdit accounting
// ---------------------------------------------------------------------------

test("Edit counts oldString as removed and newString as added", () => {
  const edit = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { filePath: "src/a.ts", oldString: "x\ny\n", newString: "p\nq\nr\n" } }],
    },
  }
  withTempTranscript(jsonl([edit]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
    strictEqual(s.fileWrites[0].linesAdded, 3)
  })
})

// Claude Code's real Edit/MultiEdit inputs are snake_case. The camelCase tests
// above are legacy fixture shapes; these pin the spelling that actually ships.
test("Edit counts real snake_case old_string/new_string", () => {
  const edit = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "src/a.ts", old_string: "x\ny\n", new_string: "p\nq\nr\n" } }],
    },
  }
  withTempTranscript(jsonl([edit]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
    strictEqual(s.fileWrites[0].linesAdded, 3)
    strictEqual(s.linesAdded, 3, "snake_case edits must reach the session total")
  })
})

test("MultiEdit sums across snake_case edits array", () => {
  const multi = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "u1",
          name: "MultiEdit",
          input: { file_path: "src/a.ts", edits: [{ old_string: "a\n", new_string: "b\nc\n" }, { old_string: "d", new_string: "e\nf" }] },
        },
      ],
    },
  }
  withTempTranscript(jsonl([multi]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 4)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
    strictEqual(s.toolCalls.edit, 1)
  })
})

test("MultiEdit sums across its edits array", () => {
  const multi = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "u1",
          name: "MultiEdit",
          input: { filePath: "src/a.ts", edits: [{ oldString: "a\n", newString: "b\nc\n" }, { oldString: "d", newString: "e\nf" }] },
        },
      ],
    },
  }
  withTempTranscript(jsonl([multi]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 4)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
    strictEqual(s.toolCalls.edit, 1)
  })
})

// ---------------------------------------------------------------------------
// Sidechain / meta exclusion
// ---------------------------------------------------------------------------

test("subagent (sidechain) and meta lines are excluded from the main thread", () => {
  const main = assistantWrite("src/main.ts", "a\n", "m1")
  const sidechain = { ...assistantWrite("src/subagent.ts", "b\n", "s1"), isSidechain: true }
  const meta = { ...assistantWrite("src/meta.ts", "c\n", "x1"), isMeta: true }
  withTempTranscript(jsonl([main, sidechain, meta]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites.length, 1)
    strictEqual(s.fileWrites[0].path, "src/main.ts")
  })
})

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test("missing transcript returns empty stats (warning goes to stderr)", () => {
  const s = parseTranscript("/nonexistent/path/session.jsonl")
  strictEqual(s.toolCalls.total, 0)
  strictEqual(s.fileWrites.length, 0)
})

test("malformed JSONL lines are skipped, valid ones parsed", () => {
  const content = "not json at all\n" + JSON.stringify(assistantWrite("src/a.ts", "a\n")) + "\n{broken\n"
  withTempTranscript(content, (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites.length, 1)
  })
})

// ---------------------------------------------------------------------------
// emptyStats export + parseStatusLineStdin
// ---------------------------------------------------------------------------

test("emptyStats returns a zeroed baseline", () => {
  const s = emptyStats()
  strictEqual(s.toolCalls.total, 0)
  strictEqual(s.fileWrites.length, 0)
  strictEqual(s.linesAdded, 0)
  strictEqual(s.thinkingTokens, 0)
})

test("parseStatusLineStdin: empty → {}, invalid JSON → {}, valid → parsed", () => {
  deepStrictEqualEmpty(parseStatusLineStdin(""))
  deepStrictEqualEmpty(parseStatusLineStdin("   "))
  deepStrictEqualEmpty(parseStatusLineStdin("{not json"))
  const parsed = parseStatusLineStdin(JSON.stringify({ session_id: "s1", cost: { total_lines_added: 10 } }))
  strictEqual(parsed.session_id, "s1")
  strictEqual(parsed.cost?.total_lines_added, 10)
})

function deepStrictEqualEmpty(x: unknown): void {
  strictEqual(Object.keys(x as object).length, 0)
}

// ---------------------------------------------------------------------------
// classifyDomain spot checks
// ---------------------------------------------------------------------------

test("classifyDomain handles nested paths and edge cases", () => {
  strictEqual(classifyDomain("packages/app/app/api/users/route.ts"), "fullstack")
  strictEqual(classifyDomain("src/lib/__tests__/util.ts"), "test")
  strictEqual(classifyDomain("infra/terraform/main.tf"), "config")
  strictEqual(classifyDomain("Makefile"), "config")
  strictEqual(classifyDomain("styles/theme.scss"), "frontend")
  strictEqual(classifyDomain("scripts/run.py"), "config")
})
