import { test } from "node:test"
import { strictEqual, deepStrictEqual, ok } from "node:assert"
import {
  emptySubagentTotals,
  fetchSubagentTotals,
  mergeSubagents,
  recordParts,
  spanOf,
  widen,
  type OpencodeClient,
} from "../opencode/plugins/subagents.ts"
import { emptyStats } from "../src/core/index.js"
import type { TranscriptStats } from "../src/core/index.js"

// ---------------------------------------------------------------------------
// Stub opencode server.
//
// Shapes copied from real opencode session storage: `children` returns the
// child sessions, `messages` returns each message with its parts inlined, and
// a `task` tool part carries the child session id in `state.metadata`.
// ---------------------------------------------------------------------------

interface StubSession {
  children: string[]
  messages: { role: string; created?: number; completed?: number; parts: unknown[] }[]
}

/** Records every call, so a test can assert what the walk actually asked for. */
interface Stub {
  client: OpencodeClient
  calls: { method: string; sessionID: string; directory: string }[]
}

function stubClient(sessions: Record<string, StubSession>, opts: { fail?: string[] } = {}): Stub {
  const calls: Stub["calls"] = []
  const fail = new Set(opts.fail ?? [])
  const client = {
    session: {
      children: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
        calls.push({ method: "children", sessionID, directory: directory ?? "" })
        if (fail.has(sessionID)) throw new Error("boom")
        return { data: (sessions[sessionID]?.children ?? []).map((id) => ({ id })) }
      },
      messages: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
        calls.push({ method: "messages", sessionID, directory: directory ?? "" })
        if (fail.has(sessionID)) throw new Error("boom")
        return {
          data: (sessions[sessionID]?.messages ?? []).map((m) => ({
            info: { role: m.role, time: { created: m.created, completed: m.completed } },
            parts: m.parts,
          })),
        }
      },
    },
  }
  return { client: client as unknown as OpencodeClient, calls }
}

const tool = (name: string, filePath?: string) => ({
  type: "tool",
  tool: name,
  ...(filePath ? { state: { input: { filePath } } } : {}),
})
const reasoning = (text: string) => ({ type: "reasoning", text })
const stepFinish = (cost: number) => ({ type: "step-finish", cost })

/** An assistant turn that read a file, thought, and cost something. */
function workTurn(cost: number, created = 0, completed = 0) {
  return {
    role: "assistant",
    created,
    completed,
    parts: [tool("read"), tool("edit"), reasoning("x".repeat(400)), stepFinish(cost)],
  }
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

test("subagent sessions are tabulated the same way the parent is", async () => {
  const { client } = stubClient({
    parent: { children: ["kid-a", "kid-b"], messages: [] },
    "kid-a": { children: [], messages: [workTurn(1.5)] },
    "kid-b": { children: [], messages: [workTurn(2.5), workTurn(1)] },
  })
  const totals = await fetchSubagentTotals(client, "parent", "/repo")

  strictEqual(totals.sessions, 2)
  strictEqual(totals.stats.assistantTurns, 3)
  // 2 tool calls per turn, bucketed by opencode's tool names.
  strictEqual(totals.stats.toolCalls.total, 6)
  strictEqual(totals.stats.toolCalls.read, 3)
  strictEqual(totals.stats.toolCalls.edit, 3)
  strictEqual(totals.stats.thinkingTurns, 3)
  strictEqual(totals.stats.thinkingTokens, 300)
  strictEqual(totals.aiCost, 5)
})

test("nested subagents are followed to the bottom", async () => {
  const { client } = stubClient({
    parent: { children: ["kid"], messages: [] },
    kid: { children: ["grandkid"], messages: [workTurn(1)] },
    grandkid: { children: [], messages: [workTurn(2)] },
  })
  const totals = await fetchSubagentTotals(client, "parent", "/repo")
  strictEqual(totals.sessions, 2)
  strictEqual(totals.aiCost, 3)
})

test("the walk never counts a session twice, and never cycles", async () => {
  const { client } = stubClient({
    // A cycle back to the parent, plus one child reachable from two places.
    parent: { children: ["kid-a", "kid-b"], messages: [] },
    "kid-a": { children: ["shared", "parent"], messages: [workTurn(1)] },
    "kid-b": { children: ["shared"], messages: [workTurn(1)] },
    shared: { children: [], messages: [workTurn(5)] },
  })
  const totals = await fetchSubagentTotals(client, "parent", "/repo")
  strictEqual(totals.sessions, 3, "kid-a, kid-b, shared — parent is not re-counted")
  strictEqual(totals.aiCost, 7, "shared counted once, not twice")
})

test("the parent session's own messages are never counted as subagent work", async () => {
  const { client } = stubClient({
    parent: { children: [], messages: [workTurn(99)] },
  })
  const totals = await fetchSubagentTotals(client, "parent", "/repo")
  strictEqual(totals.sessions, 0)
  strictEqual(totals.aiCost, 0)
  strictEqual(totals.stats.assistantTurns, 0)
})

test("the configured directory is passed on every request", async () => {
  const { client, calls } = stubClient({
    parent: { children: ["kid"], messages: [] },
    kid: { children: [], messages: [workTurn(1)] },
  })
  await fetchSubagentTotals(client, "parent", "/repo")
  ok(calls.length > 0)
  ok(
    calls.every((c) => c.directory === "/repo"),
    "a missing directory would 404 and report zero subagents",
  )
})

test("a failing child degrades to zero for that child, not for the walk", async () => {
  const { client } = stubClient(
    {
      parent: { children: ["good", "bad"], messages: [] },
      good: { children: [], messages: [workTurn(3)] },
      bad: { children: [], messages: [workTurn(100)] },
    },
    { fail: ["bad"] },
  )
  const totals = await fetchSubagentTotals(client, "parent", "/repo")
  // "bad" is still known to exist (children listed it), it just has no numbers.
  strictEqual(totals.sessions, 2)
  strictEqual(totals.aiCost, 3)
})

test("a server with no children endpoint yields empty totals, not a throw", async () => {
  const { client } = stubClient({ parent: { children: ["kid"], messages: [] } }, { fail: ["parent"] })
  const totals = await fetchSubagentTotals(client, "parent", "/repo")
  deepStrictEqual(totals, emptySubagentTotals())
})

// ---------------------------------------------------------------------------
// Merging into the parent's stats
// ---------------------------------------------------------------------------

function parentStats(): TranscriptStats {
  const s = emptyStats()
  s.toolCalls.read = 2
  s.toolCalls.total = 2
  s.thinkingTurns = 1
  s.thinkingTokens = 100
  s.assistantTurns = 4
  // The parent diff is the whole worktree, so it already includes what the
  // subagents wrote.
  s.fileWrites.push({ path: "src/a.ts", tool: "Edit", linesAdded: 50, linesRemoved: 5, domain: "backend" })
  s.linesAdded = 50
  s.linesRemoved = 5
  return s
}

test("merging adds subagent effort but never subagent lines", async () => {
  const { client } = stubClient({
    parent: { children: ["kid"], messages: [] },
    kid: { children: [], messages: [workTurn(4)] },
  })
  const subs = await fetchSubagentTotals(client, "parent", "/repo")
  const stats = parentStats()
  const before = { added: stats.linesAdded, removed: stats.linesRemoved, writes: stats.fileWrites.length }

  mergeSubagents(stats, subs, { first: 0, last: 0 })

  strictEqual(stats.toolCalls.total, 4, "2 parent + 2 subagent")
  strictEqual(stats.toolCalls.read, 3)
  strictEqual(stats.thinkingTurns, 2)
  strictEqual(stats.assistantTurns, 5)
  strictEqual(stats.subagents, 1)
  // The line counts must not move: the parent worktree diff already has them.
  strictEqual(stats.linesAdded, before.added)
  strictEqual(stats.linesRemoved, before.removed)
  strictEqual(stats.fileWrites.length, before.writes)
})

test("merging widens the duration window to cover subagent time", () => {
  const stats = emptyStats()
  const subs = emptySubagentTotals()
  subs.window = { first: 1_000, last: 9_000 }
  const window = { first: 2_000, last: 5_000 }

  mergeSubagents(stats, subs, window)

  strictEqual(window.first, 1_000)
  strictEqual(window.last, 9_000)
  strictEqual(stats.durationMs, 8_000)
})

test("merging nothing changes nothing", () => {
  const stats = parentStats()
  const snapshot = structuredClone(stats)
  mergeSubagents(stats, emptySubagentTotals(), { first: 0, last: 0 })
  strictEqual(stats.toolCalls.total, snapshot.toolCalls.total)
  strictEqual(stats.subagents, 0)
  strictEqual(stats.assistantTurns, snapshot.assistantTurns)
})

// ---------------------------------------------------------------------------
// Shared part accounting — the parent walk and the subagent walk must agree
// ---------------------------------------------------------------------------

test("recordParts buckets tools, reasoning and cost identically for either walk", () => {
  const stats = emptyStats()
  const cost = recordParts(stats, [
    tool("read"),
    tool("grep"),
    tool("bash"),
    tool("task"),
    tool("webfetch"),
    tool("some_unknown_tool"),
    reasoning("abcd"),
    stepFinish(0.25),
    stepFinish(0.75),
    { type: "text", text: "ignored" },
  ])
  strictEqual(cost, 1)
  strictEqual(stats.toolCalls.total, 6)
  strictEqual(stats.toolCalls.read, 1)
  strictEqual(stats.toolCalls.grep, 1)
  strictEqual(stats.toolCalls.bash, 1)
  strictEqual(stats.toolCalls.task, 1)
  // Web requests get their own bucket: they are billed at a longer, varying
  // read time than a local tool call.
  strictEqual(stats.toolCalls.web, 1)
  strictEqual(stats.toolCalls.other, 1)
  strictEqual(stats.thinkingTurns, 1)
  strictEqual(stats.thinkingTokens, 1)
})

test("widen/spanOf ignore missing timestamps rather than producing a bogus span", () => {
  const w = { first: 0, last: 0 }
  widen(w, undefined)
  strictEqual(spanOf(w), 0)
  widen(w, { created: 500 })
  strictEqual(spanOf(w), 0, "a start with no end is not a duration")
  widen(w, { completed: 1_500 })
  strictEqual(spanOf(w), 1_000)
  widen(w, { created: 100, completed: 200 })
  strictEqual(spanOf(w), 1_400, "the window only ever grows")
})

// ---------------------------------------------------------------------------
// Sensitivity
//
// The security role's multiplier triples (0.05 -> 0.15 of every implementation
// hour) when auth/data/infra files are involved. A subagent that only *reads*
// auth code never shows up in the worktree diff, so without this the whole
// session bills as routine.
// ---------------------------------------------------------------------------

test("a subagent reading auth code makes the session security-sensitive", async () => {
  const { client } = stubClient({
    parent: { children: ["kid"], messages: [] },
    kid: {
      children: [],
      messages: [{ role: "assistant", parts: [tool("read", "src/server/auth/session.ts")] }],
    },
  })
  const subs = await fetchSubagentTotals(client, "parent", "/repo")
  deepStrictEqual(subs.stats.filesReadPaths, ["src/server/auth/session.ts"])

  const stats = emptyStats()
  strictEqual(stats.touchesAuth, false)
  mergeSubagents(stats, subs, { first: 0, last: 0 })
  strictEqual(stats.touchesAuth, true, "read-only auth access must still flag the session")
})

test("a subagent reading infra and migrations flags those too", async () => {
  const { client } = stubClient({
    parent: { children: ["a", "b"], messages: [] },
    a: { children: [], messages: [{ role: "assistant", parts: [tool("read", "terraform/main.tf")] }] },
    b: {
      children: [],
      messages: [{ role: "assistant", parts: [tool("read", "db/migrations/004_users.sql")] }],
    },
  })
  const stats = emptyStats()
  mergeSubagents(stats, await fetchSubagentTotals(client, "parent", "/repo"), { first: 0, last: 0 })
  strictEqual(stats.touchesInfra, true)
  strictEqual(stats.touchesData, true)
  strictEqual(stats.touchesAuth, false, "unrelated paths must not flag auth")
})

test("only read paths are collected, not every tool's arguments", async () => {
  const { client } = stubClient({
    parent: { children: ["kid"], messages: [] },
    kid: {
      children: [],
      messages: [
        {
          role: "assistant",
          parts: [tool("read", "src/a.ts"), tool("edit", "src/auth/login.ts"), tool("bash")],
        },
      ],
    },
  })
  const subs = await fetchSubagentTotals(client, "parent", "/repo")
  // Written files reach the flags through the parent's worktree diff instead,
  // so collecting them here as well would be double bookkeeping.
  deepStrictEqual(subs.stats.filesReadPaths, ["src/a.ts"])
})

test("web tools are recognized on either harness, including plugin prefixes", () => {
  const stats = emptyStats()
  recordParts(stats, [
    tool("webfetch"),
    tool("websearch"),
    tool("WebFetch"),
    tool("web_search"),
    tool("mcp__some_plugin__webfetch"),
  ])
  strictEqual(stats.toolCalls.web, 5)
  strictEqual(stats.toolCalls.other, 0)
})
