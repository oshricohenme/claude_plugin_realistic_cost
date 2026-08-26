import { test } from "node:test"
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strictEqual, deepStrictEqual, ok } from "node:assert"
import {
  parseTranscript,
  emptyStats,
  parseStatusLineStdin,
  classifyDomain,
  listSubagentTranscripts,
  mcpServerOf,
  transcriptSignature,
} from "../src/core/index.js"

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

const assistantWrite = (path: string, content: string, id = "u1") => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Write", input: { filePath: path, content } }],
  },
})

const toolUse = (name: string, input: Record<string, unknown>, id = "u1") => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
})

// ---------------------------------------------------------------------------
// Tool-input key casing.
//
// Claude Code records tool inputs in snake_case (file_path, old_string,
// new_string). Reading only camelCase scored every Edit as zero lines, which
// silently under-priced real sessions by ~30% while a camelCase-only test
// suite stayed green. These tests pin BOTH spellings.
// ---------------------------------------------------------------------------

test("Edit line counts are identical for snake_case and camelCase inputs", () => {
  const snake = toolUse("Edit", { file_path: "src/a.ts", old_string: "x\ny\n", new_string: "p\nq\nr\n" })
  const camel = toolUse("Edit", { filePath: "src/a.ts", oldString: "x\ny\n", newString: "p\nq\nr\n" })
  withTempTranscript(jsonl([snake]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 3, "snake_case new_string counted")
    strictEqual(s.fileWrites[0].linesRemoved, 2, "snake_case old_string counted")
    strictEqual(s.fileWrites[0].path, "src/a.ts", "snake_case file_path read")
  })
  withTempTranscript(jsonl([camel]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 3)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
  })
})

test("Write and MultiEdit accept snake_case inputs", () => {
  const write = toolUse("Write", { file_path: "src/new.ts", content: "1\n2\n3\n" }, "w1")
  const multi = toolUse(
    "MultiEdit",
    {
      file_path: "src/b.ts",
      edits: [
        { old_string: "a\n", new_string: "b\nc\n" },
        { old_string: "d", new_string: "e\nf" },
      ],
    },
    "m1",
  )
  withTempTranscript(jsonl([write, multi]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesAdded, 3, "Write content")
    strictEqual(s.fileWrites[0].path, "src/new.ts")
    strictEqual(s.fileWrites[1].linesAdded, 4, "MultiEdit new_string lines")
    strictEqual(s.fileWrites[1].linesRemoved, 2, "MultiEdit old_string lines")
  })
})

test("tool names are matched case-insensitively across harnesses", () => {
  withTempTranscript(
    jsonl([
      toolUse("Read", { file_path: "src/a.ts" }, "r1"),
      toolUse("read", { filePath: "src/b.ts" }, "r2"),
      toolUse("Grep", { pattern: "x" }, "g1"),
      toolUse("grep", { pattern: "y" }, "g2"),
    ]),
    (tp) => {
      const s = parseTranscript(tp)
      strictEqual(s.toolCalls.read, 2, "Read and read both count")
      strictEqual(s.toolCalls.grep, 2, "Grep and grep both count")
      strictEqual(s.toolCalls.other, 0, "nothing fell through to the default bucket")
      strictEqual(s.filesReadPaths.length, 2, "read paths captured in both casings")
    },
  )
})

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
      content: [
        {
          type: "tool_use",
          id: "u1",
          name: "Edit",
          input: { filePath: "src/a.ts", oldString: "x\ny\n", newString: "p\nq\nr\n" },
        },
      ],
    },
  }
  withTempTranscript(jsonl([edit]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites[0].linesRemoved, 2)
    strictEqual(s.fileWrites[0].linesAdded, 3)
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
          input: {
            filePath: "src/a.ts",
            edits: [
              { oldString: "a\n", newString: "b\nc\n" },
              { oldString: "d", newString: "e\nf" },
            ],
          },
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
// Subagent work counts; meta lines do not
//
// A subagent's writes appear ONLY on its own sidechain — the parent thread
// records just the Task call and its text result. Dropping them priced a
// delegating session as if the delegated work never happened.
// ---------------------------------------------------------------------------

test("inline sidechain (subagent) lines are counted; meta lines are not", () => {
  const main = assistantWrite("src/main.ts", "a\n", "m1")
  const sidechain = {
    ...assistantWrite("src/subagent.ts", "b\n", "s1"),
    isSidechain: true,
    agentId: "agent-1",
  }
  const meta = { ...assistantWrite("src/meta.ts", "c\n", "x1"), isMeta: true }
  withTempTranscript(jsonl([main, sidechain, meta]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.fileWrites.length, 2)
    deepStrictEqual(s.fileWrites.map((w) => w.path).sort(), ["src/main.ts", "src/subagent.ts"])
    strictEqual(s.subagents, 1)
  })
})

test("distinct inline agentIds count as distinct subagents", () => {
  const lines = [
    assistantWrite("src/main.ts", "a\n", "m1"),
    { ...assistantWrite("src/a.ts", "b\n", "s1"), isSidechain: true, agentId: "agent-1" },
    { ...assistantWrite("src/b.ts", "c\n", "s2"), isSidechain: true, agentId: "agent-1" },
    { ...assistantWrite("src/c.ts", "d\n", "s3"), isSidechain: true, agentId: "agent-2" },
  ]
  withTempTranscript(jsonl(lines), (tp) => {
    strictEqual(parseTranscript(tp).subagents, 2)
  })
})

/**
 * Newer Claude Code keeps each subagent in its own sidecar transcript under
 * `<transcript-without-.jsonl>/subagents/`, nested one level deeper for
 * workflow runs. `journal.jsonl` and `.meta.json` share those directories and
 * must not be parsed as transcripts.
 */
function withSubagentTranscripts(
  main: string,
  sidecars: Record<string, string>,
  fn: (path: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "rc-sa-"))
  const tp = join(dir, "session.jsonl")
  writeFileSync(tp, main, "utf8")
  for (const [rel, content] of Object.entries(sidecars)) {
    const full = join(dir, "session", "subagents", rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content, "utf8")
  }
  try {
    fn(tp)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("sidecar subagent transcripts are discovered and folded in", () => {
  const main = jsonl([assistantWrite("src/main.ts", "a\n", "m1")])
  const sub = (path: string, id: string) =>
    jsonl([{ ...assistantWrite(path, "x\ny\n", id), isSidechain: true, agentId: id }])
  withSubagentTranscripts(
    main,
    {
      "agent-a1.jsonl": sub("src/one.ts", "a1"),
      "workflows/wf_1/agent-a2.jsonl": sub("src/two.ts", "a2"),
      // Neither of these is a subagent transcript.
      "workflows/wf_1/journal.jsonl": jsonl([assistantWrite("src/nope.ts", "z\n", "j1")]),
      "workflows/wf_1/agent-a2.meta.json": JSON.stringify({ agentType: "general-purpose" }),
    },
    (tp) => {
      const s = parseTranscript(tp)
      deepStrictEqual(s.fileWrites.map((w) => w.path).sort(), ["src/main.ts", "src/one.ts", "src/two.ts"])
      strictEqual(s.subagents, 2)
      strictEqual(s.linesAdded, 5)
      strictEqual(listSubagentTranscripts(tp).length, 2)
    },
  )
})

test("a session with no subagents reports none and discovers no sidecars", () => {
  withTempTranscript(jsonl([assistantWrite("src/main.ts", "a\n", "m1")]), (tp) => {
    strictEqual(parseTranscript(tp).subagents, 0)
    deepStrictEqual(listSubagentTranscripts(tp), [])
  })
})

test("the cache signature changes when a subagent transcript changes", () => {
  const main = jsonl([assistantWrite("src/main.ts", "a\n", "m1")])
  withSubagentTranscripts(main, { "agent-a1.jsonl": "" }, (tp) => {
    const before = transcriptSignature(tp)
    writeFileSync(
      join(tp.replace(/\.jsonl$/, ""), "subagents", "agent-a1.jsonl"),
      jsonl([{ ...assistantWrite("src/one.ts", "x\n", "a1"), isSidechain: true, agentId: "a1" }]),
      "utf8",
    )
    ok(transcriptSignature(tp) !== before, "signature must track sidecar changes")
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

test("data-engineering paths classify as the data domain", () => {
  strictEqual(classifyDomain("db/migrations/0007_add_users.sql"), "data")
  strictEqual(classifyDomain("prisma/schema.prisma"), "data")
  strictEqual(classifyDomain("app/db/migrations/001_init.ts"), "data")
  strictEqual(classifyDomain("queries/report.sql"), "data")
  // Ordinary backend code is still backend.
  strictEqual(classifyDomain("src/api/server.ts"), "backend")
  // Tests and docs still win over data.
  strictEqual(classifyDomain("test/migrations.test.ts"), "test")
})

// ---------------------------------------------------------------------------
// MCP calls — another department's system
// ---------------------------------------------------------------------------

test("mcp__server__tool calls are attributed to their server", () => {
  strictEqual(mcpServerOf("mcp__graphify__graphify_find"), "graphify")
  strictEqual(mcpServerOf("mcp__claude-in-chrome__navigate"), "claude-in-chrome")
  strictEqual(mcpServerOf("Read"), "", "a local tool is not another department")
  strictEqual(mcpServerOf("Bash"), "")
})

test("opencode's flattened names need the configured server list to be recognized", () => {
  // `pty_spawn` and `graphify_recall` are indistinguishable by shape, and only
  // one of them is another team — so without the list, neither is guessed at.
  strictEqual(mcpServerOf("graphify_recall"), "")
  strictEqual(mcpServerOf("graphify_recall", ["graphify"]), "graphify")
  strictEqual(mcpServerOf("pty_spawn", ["graphify"]), "", "a plugin tool must not inflate the bill")
  strictEqual(mcpServerOf("deja", ["deja"]), "deja", "a bare server name counts too")
})

test("a transcript's MCP calls and distinct servers are counted", () => {
  const lines = [
    toolUse("mcp__graphify__graphify_find", {}, "t1"),
    toolUse("mcp__graphify__graphify_callers", {}, "t2"),
    toolUse("mcp__posthog__exec", {}, "t3"),
    toolUse("Read", { file_path: "src/a.ts" }, "t4"),
  ]
  withTempTranscript(jsonl(lines), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.mcpCalls, 3)
    deepStrictEqual(s.mcpServers.sort(), ["graphify", "posthog"])
    // MCP tagging must not disturb the work-time buckets.
    strictEqual(s.toolCalls.total, 4)
    strictEqual(s.toolCalls.read, 1)
  })
})

test("an MCP web tool counts as both a web request and a cross-department call", () => {
  withTempTranscript(jsonl([toolUse("mcp__exa__websearch", {}, "t1")]), (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.toolCalls.web, 1, "still billed at web read time")
    strictEqual(s.mcpCalls, 1, "and still another department")
    deepStrictEqual(s.mcpServers, ["exa"])
  })
})

test("subagent MCP calls count toward the session's departments", () => {
  const main = jsonl([toolUse("Read", { file_path: "a.ts" }, "m1")])
  const sub = jsonl([{ ...toolUse("mcp__graphify__recall", {}, "s1"), isSidechain: true, agentId: "a1" }])
  withSubagentTranscripts(main, { "agent-a1.jsonl": sub }, (tp) => {
    const s = parseTranscript(tp)
    strictEqual(s.mcpCalls, 1)
    deepStrictEqual(s.mcpServers, ["graphify"])
  })
})
