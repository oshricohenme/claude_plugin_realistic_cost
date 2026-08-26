import { test } from "node:test"
import { strictEqual, ok, deepStrictEqual } from "node:assert"

/** assert actual ≈ expected within delta. */
function approx(actual: number, expected: number, delta: number, msg?: string): void {
  ok(Math.abs(actual - expected) <= delta, msg ?? `${actual} ≉ ${expected} (±${delta})`)
}
import { ESTIMATE_DEFAULTS, computeCost, estimateHours, resolveEstimateOptions } from "../src/core/index.js"
import type { TranscriptStats } from "../src/core/index.js"

function stats(overrides: Partial<TranscriptStats> = {}): TranscriptStats {
  return {
    transcriptPath: "",
    toolCalls: { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, web: 0, other: 0, total: 0 },
    thinkingTurns: 0,
    thinkingTokens: 0,
    assistantTurns: 0,
    subagents: 0,
    mcpCalls: 0,
    mcpServers: [],
    fileWrites: [],
    filesReadPaths: [],
    durationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    touchesAuth: false,
    touchesData: false,
    touchesInfra: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Option plumbing — regression for the EstimateOptions/DEFAULTS key mismatch
// that silently ignored every *Multiplier override.
// ---------------------------------------------------------------------------

test("EstimateOptions overrides actually change the estimate", () => {
  const s = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 120, linesRemoved: 0, domain: "backend" }],
  })
  const base = estimateHours(s)
  const overridden = estimateHours(s, {
    reviewOverheadMultiplier: 0.9,
    pmOverheadMultiplier: 0.5,
    qaOverheadMultiplier: 0.2,
  })

  const role = (e: ReturnType<typeof estimateHours>, id: string) => e.roles.find((r) => r.role === id)
  ok(
    role(overridden, "backend")!.overheadHours > role(base, "backend")!.overheadHours,
    "review override applied",
  )
  ok(role(overridden, "pm")!.overheadHours > role(base, "pm")!.overheadHours, "pm override applied")

  // 120 lines > threshold of 100 → impl already carries the large-change
  // multiplier; check percentage math directly instead.
  const impl = role(base, "backend")!.implementationHours
  strictEqual(
    Math.round((role(base, "backend")!.overheadHours / impl) * 100),
    35,
    "default review overhead is 35%",
  )
  strictEqual(
    Math.round((role(overridden, "backend")!.overheadHours / impl) * 100),
    90,
    "overridden review overhead is 90%",
  )
  // No test files written → QA at qaOverheadMultiplier (0.2 override).
  strictEqual(
    Math.round((role(overridden, "qa")!.overheadHours / overridden.implementationHours) * 100),
    20,
    "qa override applied",
  )
})

// ---------------------------------------------------------------------------
// QA multiplier — regression for "any Write triggers the tests-written rate"
// ---------------------------------------------------------------------------

test("QA overhead uses the no-tests rate unless test files were written", () => {
  const prodOnly = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const withTests = stats({
    fileWrites: [
      { path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" },
      { path: "src/api.test.ts", tool: "Write", linesAdded: 20, linesRemoved: 0, domain: "test" },
    ],
  })

  const qaShare = (s: TranscriptStats) => {
    const e = estimateHours(s)
    const qa = e.roles.find((r) => r.role === "qa")!
    return qa.overheadHours / e.implementationHours
  }
  ok(Math.abs(qaShare(prodOnly) - 0.5) < 1e-9, "prod-only writes → 50% QA overhead")
  ok(Math.abs(qaShare(withTests) - 0.35) < 1e-9, "test files written → 35% QA overhead")
})

// ---------------------------------------------------------------------------
// Per-write complexity multipliers
// ---------------------------------------------------------------------------

test("new-file (Write) ops cost more than equivalent Edit ops", () => {
  const viaWrite = stats({
    fileWrites: [{ path: "src/a.ts", tool: "Write", linesAdded: 40, linesRemoved: 0, domain: "backend" }],
  })
  const viaEdit = stats({
    fileWrites: [{ path: "src/a.ts", tool: "Edit", linesAdded: 40, linesRemoved: 0, domain: "backend" }],
  })
  const hw = estimateHours(viaWrite).domainBreakdown.backend.hours
  const he = estimateHours(viaEdit).domainBreakdown.backend.hours
  ok(Math.abs(hw / he - 1.5) < 1e-9, `Write 40 lines = 1.5x Edit 40 lines (got ${hw}/${he})`)
})

test("large-change multiplier applies per write, not on domain average", () => {
  // 150-line write: 150 * 1.5 (new file) * 1.3 (large) weighted lines.
  const oneBig = stats({
    fileWrites: [{ path: "src/big.ts", tool: "Write", linesAdded: 150, linesRemoved: 0, domain: "backend" }],
  })
  // 3x 50-line writes: 150 * 1.5 (new files), no large-change multiplier.
  const threeSmall = stats({
    fileWrites: [
      { path: "src/s1.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
      { path: "src/s2.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
      { path: "src/s3.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
    ],
  })
  const wb = estimateHours(oneBig).domainBreakdown.backend.weightedLinesAdded
  const ws = estimateHours(threeSmall).domainBreakdown.backend.weightedLinesAdded
  strictEqual(wb, 150 * 1.5 * 1.3, "single 150-line write weighted 1.5*1.3")
  strictEqual(ws, 150 * 1.5, "three 50-line writes weighted 1.5 only")
})

test("complexity multiplier applies per write and stays under the 6x cap", () => {
  const s = stats({
    fileWrites: [{ path: "src/x.ts", tool: "Write", linesAdded: 500, linesRemoved: 0, domain: "backend" }],
  })
  const w = estimateHours(s).domainBreakdown.backend.weightedLinesAdded
  ok(Math.abs(w - 500 * 1.5 * 1.3) < 1e-9, "new file + large change multiply (1.95x)")
  ok(w / 500 <= 6, "weight never exceeds 6x")
})

// ---------------------------------------------------------------------------
// Domain breakdown shape
// ---------------------------------------------------------------------------

test("domainBreakdown tracks newFiles and raw line counts separately from weights", () => {
  const s = stats({
    fileWrites: [
      { path: "src/a.ts", tool: "Write", linesAdded: 30, linesRemoved: 0, domain: "backend" },
      { path: "src/a.ts", tool: "Edit", linesAdded: 10, linesRemoved: 4, domain: "backend" },
    ],
  })
  const b = estimateHours(s).domainBreakdown.backend
  strictEqual(b.files, 2)
  strictEqual(b.newFiles, 1)
  strictEqual(b.linesAdded, 40)
  strictEqual(b.linesRemoved, 4)
  strictEqual(b.weightedLinesAdded, 30 * 1.5 + 10)
})

test("role notes quote the configured percentages, not hardcoded strings", () => {
  const s = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const note = estimateHours(s, { reviewOverheadMultiplier: 0.45 }).roles.find(
    (r) => r.role === "backend",
  )!.note
  ok(note.includes("45%"), `note reflects configured review overhead: "${note}"`)
})

test("tool-call hours are honored and uniform across tool types", () => {
  const ten = (bucket: keyof TranscriptStats["toolCalls"]) =>
    stats({
      toolCalls: {
        read: 0,
        write: 0,
        edit: 0,
        glob: 0,
        grep: 0,
        bash: 0,
        task: 0,
        web: 0,
        other: 0,
        total: 10,
        [bucket]: 10,
      } as TranscriptStats["toolCalls"],
    })

  // "Every tool call costs about 30 minutes" means exactly that: a read, a
  // grep and a bash call are all worth the same half hour.
  for (const bucket of ["read", "grep", "bash", "edit"] as const) {
    strictEqual(estimateHours(ten(bucket)).toolWorkHours, 5, `${bucket} bills 10 x 0.5h`)
    strictEqual(estimateHours(ten(bucket)).toolCoordinationHours, 5)
  }

  const tuned = estimateHours(ten("read"), { toolCallWorkHours: 1.25 })
  strictEqual(tuned.toolWorkHours, 12.5)
  strictEqual(estimateHours(ten("read"), { toolCallCoordinationHours: 0 }).toolCoordinationHours, 0)
})

test("thinking turns still drive discovery hours", () => {
  const base = estimateHours(stats({ thinkingTurns: 10 }))
  strictEqual(base.discoveryHours, 1)
  strictEqual(estimateHours(stats({ thinkingTurns: 10 }), { discoveryThinkingHours: 0.5 }).discoveryHours, 5)
})

// ---------------------------------------------------------------------------
// Web requests
// ---------------------------------------------------------------------------

const webStats = (count: number, transcriptPath = "/tmp/a.jsonl") =>
  stats({
    transcriptPath,
    toolCalls: {
      read: 0,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: count,
      other: 0,
      total: count,
    },
  })

test("a web request costs between 30 and 60 minutes, not the flat half hour", () => {
  for (const n of [1, 5, 40]) {
    const h = estimateHours(webStats(n)).toolWorkHours
    ok(h > n * 0.5, `${n} web requests must cost more than ${n} x 0.5h (got ${h})`)
    ok(h <= n * 1.0, `${n} web requests must cost at most ${n} x 1h (got ${h})`)
  }
})

test("web request time varies call to call rather than being a flat average", () => {
  const perCall = new Set<number>()
  let prev = 0
  for (let n = 1; n <= 6; n++) {
    const h = estimateHours(webStats(n)).toolWorkHours
    perCall.add(+(h - prev).toFixed(6))
    prev = h
  }
  ok(perCall.size > 1, "each successive web request must draw its own read time")
})

test("the same session always prices identically — a status line cannot flicker", () => {
  const first = estimateHours(webStats(25)).toolWorkHours
  for (let i = 0; i < 5; i++) {
    strictEqual(estimateHours(webStats(25)).toolWorkHours, first, "repeat runs must agree exactly")
  }
})

test("different sessions draw different web read times", () => {
  const a = estimateHours(webStats(25, "/tmp/session-a.jsonl")).toolWorkHours
  const b = estimateHours(webStats(25, "/tmp/session-b.jsonl")).toolWorkHours
  ok(a !== b, "the draw is seeded per session")
})

test("web request bounds are configurable, and a degenerate range is flat", () => {
  const wide = estimateHours(webStats(10), { webRequestMinHours: 2, webRequestMaxHours: 4 }).toolWorkHours
  ok(wide > 20 && wide <= 40, `expected 10 calls in [20h, 40h], got ${wide}`)
  const flat = estimateHours(webStats(10), { webRequestMinHours: 1, webRequestMaxHours: 1 }).toolWorkHours
  strictEqual(flat, 10)
  // Reversed bounds must not silently produce negative or zero time.
  const reversed = estimateHours(webStats(10), {
    webRequestMinHours: 1,
    webRequestMaxHours: 0.5,
  }).toolWorkHours
  ok(reversed >= 5 && reversed <= 10, `reversed bounds should still land in range, got ${reversed}`)
})

test("web requests do not also bill the flat per-call work rate", () => {
  const mixed = stats({
    toolCalls: {
      read: 5,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 5,
      other: 0,
      total: 10,
    },
  })
  const h = estimateHours(mixed).toolWorkHours
  // 5 reads at 0.5h, plus 5 web requests somewhere in [0.5h, 1h] each.
  ok(h > 2.5 + 2.5 && h <= 2.5 + 5, `expected (5h, 7.5h], got ${h}`)
  // Coordination is per call regardless of kind.
  strictEqual(estimateHours(mixed).toolCoordinationHours, 5)
})

test("empty stats produce a near-zero estimate with all roles present", () => {
  const e = estimateHours(stats())
  strictEqual(e.roles.length, 11)
  strictEqual(e.implementationHours, 0)
  // PM and EM carry 3h minimums even with no work — the standing cost of
  // having a team at all.
  strictEqual(e.totalProductiveHours, 6)
  deepStrictEqual(Object.keys(e.domainBreakdown).sort(), [
    "backend",
    "config",
    "data",
    "design",
    "docs",
    "frontend",
    "fullstack",
    "other",
    "test",
  ])
})

test("schema and migration files are billed to the data engineer", () => {
  const s = stats({
    fileWrites: [
      {
        path: "db/migrations/0007_add_users.sql",
        tool: "Write",
        linesAdded: 40,
        linesRemoved: 0,
        domain: "data",
      },
      { path: "prisma/schema.prisma", tool: "Edit", linesAdded: 10, linesRemoved: 2, domain: "data" },
    ],
  })
  const e = estimateHours(s)
  const data = e.roles.find((r) => r.role === "data")!
  ok(data.implementationHours > 0, "data role gets implementation hours, not a hardcoded zero")
  ok(data.overheadHours > 0, "data work is peer reviewed like any other engineering")
  ok(e.implementationHours >= data.implementationHours, "data hours are part of total impl")
})

// ---------------------------------------------------------------------------
// Single source of truth for the model parameters.
//
// cost.ts used to restate the whole DEFAULTS table verbatim. Nothing pinned
// the two copies together, so tuning the role model and tuning the receipt
// could silently diverge. Both now resolve through resolveEstimateOptions.
// ---------------------------------------------------------------------------

test("every EstimateOptions key has exactly one default, shared by estimate and cost", () => {
  const resolved = resolveEstimateOptions()
  deepStrictEqual(
    resolved,
    ESTIMATE_DEFAULTS,
    "resolveEstimateOptions() with no overrides is the defaults table",
  )

  // Every default must be a real, finite number — a typo'd key would show up
  // here as undefined rather than silently disabling an option.
  for (const [key, value] of Object.entries(ESTIMATE_DEFAULTS)) {
    ok(typeof value === "number" && Number.isFinite(value), `${key} has a numeric default`)
  }

  // An override of any single key must survive resolution untouched, and must
  // reach the receipt: computeCost resolves the same options object.
  for (const key of Object.keys(ESTIMATE_DEFAULTS) as (keyof typeof ESTIMATE_DEFAULTS)[]) {
    const bumped = ESTIMATE_DEFAULTS[key] + 1
    strictEqual(resolveEstimateOptions({ [key]: bumped })[key], bumped, `${key} override is applied`)
  }
})

test("thinking cost per token is tunable rather than hard-coded", () => {
  const s = stats({
    thinkingTokens: 5000,
    toolCalls: { read: 2, write: 1, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, web: 0, other: 0, total: 3 },
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const est = estimateHours(s)
  const base = computeCost({ stats: s, estimate: est })
  const cheap = computeCost({
    stats: s,
    estimate: est,
    options: { estimateOptions: { thinkingCostPerToken: 0.005 } },
  })
  const think = (r: typeof base) => r.activities.find((a) => a.activity === "Thinking")?.cost ?? 0
  ok(think(cheap) < think(base), "lowering the per-token price lowers the thinking line item")
})

// ---------------------------------------------------------------------------
// Cross-team overhead — MCP servers and subagents are other teams
// ---------------------------------------------------------------------------

const emHours = (e: ReturnType<typeof estimateHours>) => e.roles.find((r) => r.role === "em")!.totalHours
const pmHours = (e: ReturnType<typeof estimateHours>) => e.roles.find((r) => r.role === "pm")!.totalHours

test("MCP calls bill cross-department coordination on top of the normal per-call cost", () => {
  const local = stats({
    toolCalls: {
      read: 10,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 0,
      other: 0,
      total: 10,
    },
  })
  const external = stats({
    ...local,
    mcpCalls: 10,
    mcpServers: ["graphify"],
  })
  strictEqual(estimateHours(local).mcpCoordinationHours, 0)
  strictEqual(estimateHours(external).mcpCoordinationHours, 10, "10 calls x 1h cross-team sync")
  // Tool work is unchanged — an MCP read is still a read; it just costs extra
  // coordination because it went to another department.
  strictEqual(estimateHours(external).toolWorkHours, estimateHours(local).toolWorkHours)
})

test("management is charged per MCP department, not per MCP call", () => {
  const one = stats({ mcpCalls: 50, mcpServers: ["graphify"] })
  const three = stats({ mcpCalls: 50, mcpServers: ["graphify", "posthog", "serena"] })
  // 4h per department, split evenly between PM and EM.
  approx(pmHours(estimateHours(three)) - pmHours(estimateHours(one)), 4, 1e-9)
  approx(emHours(estimateHours(three)) - emHours(estimateHours(one)), 4, 1e-9)
  // Fifty calls to one department cost the same alignment as one call to it.
  approx(
    pmHours(estimateHours(one)),
    pmHours(estimateHours(stats({ mcpCalls: 1, mcpServers: ["graphify"] }))),
    1e-9,
  )
})

test("each subagent bills coordination and engineering-management time", () => {
  const none = estimateHours(stats())
  const five = estimateHours(stats({ subagents: 5 }))
  strictEqual(five.subagentCoordinationHours, 10, "5 teams x 2h coordination")
  approx(emHours(five) - emHours(none), 20, 1e-9, "5 teams x 4h of EM")
  approx(pmHours(five) - pmHours(none), 0, 1e-9, "subagent management is the EM's, not the PM's")
})

test("cross-team rates are configurable", () => {
  const s = stats({ subagents: 2, mcpCalls: 4, mcpServers: ["a", "b"] })
  const e = estimateHours(s, {
    subagentCoordinationHours: 0,
    subagentManagementHours: 0,
    mcpCallCoordinationHours: 0,
    mcpServerManagementHours: 0,
  })
  strictEqual(e.subagentCoordinationHours, 0)
  strictEqual(e.mcpCoordinationHours, 0)
  approx(emHours(e), emHours(estimateHours(stats())), 1e-9, "zeroed knobs remove all cross-team cost")
})

test("role notes name the teams that were involved", () => {
  const e = estimateHours(stats({ subagents: 3, mcpCalls: 2, mcpServers: ["graphify"] }))
  const em = e.roles.find((r) => r.role === "em")!
  ok(em.note.includes("3 subagent team(s)"), em.note)
  ok(em.note.includes("1 MCP department(s)"), em.note)
})

test("stats from an older cache with no cross-team fields price as zero, not a crash", () => {
  // The status line caches parsed stats as JSON on disk; an entry written
  // before these fields existed must not take the estimator down.
  const legacy = stats()
  delete (legacy as Partial<TranscriptStats>).mcpCalls
  delete (legacy as Partial<TranscriptStats>).mcpServers
  delete (legacy as Partial<TranscriptStats>).subagents
  const e = estimateHours(legacy)
  strictEqual(e.mcpCoordinationHours, 0)
  strictEqual(e.subagentCoordinationHours, 0)
  strictEqual(emHours(e), 3, "falls back to the bare 3h EM baseline")
})

test("comprehension is charged in addition to tool work, not instead of it", () => {
  const s = stats({
    toolCalls: {
      read: 10,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 0,
      other: 0,
      total: 10,
    },
  })
  const e = estimateHours(s)
  strictEqual(e.toolWorkHours, 5, "10 calls x 0.5h of operating the tool")
  approx(e.comprehensionHours, 0.75, 1e-9, "10 reads x 0.15h, half billed to the engineer")
  ok(e.comprehensionHours > 0, "the Code Comprehension line must survive")
  const tuned = estimateHours(s, { discoveryReadHours: 0.5 })
  ok(tuned.comprehensionHours > e.comprehensionHours, "discoveryReadHours still tunes comprehension")
})

// ---------------------------------------------------------------------------
// The other department's own work
// ---------------------------------------------------------------------------

const mcp = (calls: number, servers: string[], transcriptPath = "/tmp/s.jsonl") =>
  stats({
    transcriptPath,
    mcpCalls: calls,
    mcpServers: servers,
    toolCalls: {
      read: 0,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 0,
      other: calls,
      total: calls,
    },
  })

test("each MCP call bills 2-5h of the other department's work", () => {
  for (const n of [1, 10, 100]) {
    const h = estimateHours(mcp(n, ["graphify"])).mcpDepartmentWorkHours
    ok(h >= n * 2, `${n} calls must bill at least ${n * 2}h (got ${h})`)
    ok(h <= n * 5, `${n} calls must bill at most ${n * 5}h (got ${h})`)
  }
  strictEqual(estimateHours(stats()).mcpDepartmentWorkHours, 0, "no MCP, no department work")
})

test("department work varies per call but is stable for a session", () => {
  const first = estimateHours(mcp(30, ["a"])).mcpDepartmentWorkHours
  strictEqual(estimateHours(mcp(30, ["a"])).mcpDepartmentWorkHours, first, "must not flicker")
  // Not a flat average: successive calls draw their own durations.
  const deltas = new Set<number>()
  let prev = 0
  for (let n = 1; n <= 6; n++) {
    const h = estimateHours(mcp(n, ["a"])).mcpDepartmentWorkHours
    deltas.add(+(h - prev).toFixed(6))
    prev = h
  }
  ok(deltas.size > 1)
})

test("web and MCP draws use different sequences in the same session", () => {
  const s = stats({
    transcriptPath: "/tmp/same.jsonl",
    mcpCalls: 20,
    mcpServers: ["a"],
    toolCalls: {
      read: 0,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 20,
      other: 0,
      total: 20,
    },
  })
  const e = estimateHours(s, {
    // Same bounds for both, so an identical sequence would give identical sums.
    webRequestMinHours: 2,
    webRequestMaxHours: 5,
  })
  ok(
    Math.abs(e.toolWorkHours - e.mcpDepartmentWorkHours) > 1e-9,
    "web and MCP must not replay the same draws",
  )
})

test("MCP calls pay a multiple of the per-call email time", () => {
  const local = stats({
    toolCalls: {
      read: 10,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      web: 0,
      other: 0,
      total: 10,
    },
  })
  strictEqual(estimateHours(local).toolCoordinationHours, 5, "10 local calls x 0.5h")
  strictEqual(estimateHours(mcp(10, ["a"])).toolCoordinationHours, 10, "10 MCP calls x 0.5h x factor 2")
  strictEqual(
    estimateHours(mcp(10, ["a"]), { mcpCallCoordinationFactor: 1 }).toolCoordinationHours,
    5,
    "factor 1 removes the premium",
  )
})

test("engineers are billed meeting time per MCP department, as overhead not value", () => {
  const base = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Edit", linesAdded: 100, linesRemoved: 0, domain: "backend" }],
  })
  const withMcp = stats({ ...base, mcpCalls: 5, mcpServers: ["a", "b"] })
  const be = (e: ReturnType<typeof estimateHours>) => e.roles.find((r) => r.role === "backend")!

  const e0 = estimateHours(base)
  const e1 = estimateHours(withMcp)
  strictEqual(e1.mcpEngineeringHours, 8, "2 departments x 4h")
  approx(be(e1).overheadHours - be(e0).overheadHours, 8, 1e-9, "lands on the engineer as overhead")
  approx(be(e1).implementationHours, be(e0).implementationHours, 1e-9, "never as implementation")
  // Implementation drives every downstream multiplier, so meeting time must
  // not leak into it and quietly inflate PM/EM/QA/security.
  approx(e1.implementationHours, e0.implementationHours, 1e-9)
  ok(be(e1).note.includes("cross-dept meetings"), be(e1).note)
})

test("cross-department meeting time follows whichever stack did the work", () => {
  const fe = estimateHours(
    stats({
      mcpCalls: 1,
      mcpServers: ["a"],
      fileWrites: [
        { path: "src/App.tsx", tool: "Edit", linesAdded: 50, linesRemoved: 0, domain: "frontend" },
      ],
    }),
  )
  strictEqual(fe.roles.find((r) => r.role === "frontend")!.overheadHours >= 4, true)
  strictEqual(fe.roles.find((r) => r.role === "backend")!.overheadHours, 0)
})
