import { test } from "node:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ok, strictEqual } from "node:assert"
import * as core from "../src/core/index.js"

// ---------------------------------------------------------------------------
// Engine parity for the opencode TUI plugin.
//
// The plugin used to ship a self-contained copy of the cost engine, and that
// copy silently drifted — PM/EM derived from the grand total instead of role
// hours, a missing new-file multiplier, complexity applied per domain instead
// of per write — so the same session was priced differently in each harness.
// The copy has been deleted: the plugin now imports the one engine in
// `src/core/`.
//
// That makes drift structurally impossible, but only for as long as nobody
// reintroduces a local copy — so this suite guards the shape of the plugin
// rather than comparing two implementations. It is a source-level check on
// purpose: the plugin resolves JSX and its host API through bun, so it cannot
// be imported by `node --test`, and `npm run typecheck` deliberately excludes
// it (see tsconfig.opencode.json). Without this, a reintroduced copy would
// only be caught by the separate `opencode-plugin` CI job.
// ---------------------------------------------------------------------------

const TUI_PATH = resolve(import.meta.dirname, "../opencode/plugins/realistic-cost-tui.tsx")
const CORE_SPECIFIER = "pre_ai_dev_cost_receipt/core"

const tuiSource = readFileSync(TUI_PATH, "utf8")

/** The identifiers the plugin pulls in from the shared engine. */
function importedCoreSymbols(src: string): string[] {
  const m = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${CORE_SPECIFIER}["']`).exec(src)
  ok(m, `TUI plugin must import from "${CORE_SPECIFIER}"`)
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^type\s+/, ""))
    .map((s) => s.split(/\s+as\s+/)[0].trim())
}

test("the opencode TUI plugin has no engine of its own", () => {
  ok(tuiSource.includes(CORE_SPECIFIER), `TUI plugin must source its numbers from "${CORE_SPECIFIER}"`)
  ok(
    !/INLINED ENGINE/.test(tuiSource),
    "TUI plugin reintroduced an inlined engine — import from src/core instead",
  )

  // Locally redefining any of these is how the two engines diverged before.
  // The plugin may *call* them; it must not declare them.
  for (const name of ["estimateHours", "computeCost", "classifyDomain", "applyPathFlags"]) {
    ok(
      !new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`).test(tuiSource),
      `TUI plugin declares its own ${name}() — it must import it from the shared engine`,
    )
  }

  // A hardcoded rate table is the other half of the old duplicated engine.
  ok(
    !/\bconst\s+RATES\b/.test(tuiSource),
    "TUI plugin declares its own RATES table — rates live in src/core/rates.ts",
  )
})

test("every symbol the TUI plugin imports is exported by src/core", () => {
  const imported = importedCoreSymbols(tuiSource)
  ok(imported.length > 0, "TUI plugin imports nothing from the shared engine")

  // Types are erased at runtime, so only value exports are checkable here.
  // The `opencode-plugin` CI job typechecks the rest.
  const values = imported.filter((n) => !/^[A-Z]/.test(n))
  const exported = new Set(Object.keys(core))

  for (const name of values) {
    ok(exported.has(name), `TUI plugin imports "${name}", which src/core/index.ts does not export`)
  }
})

test("the TUI derives the coordination percentage instead of hardcoding it", () => {
  const stats = core.emptyStats()
  const report = core.computeCost({ stats, estimate: core.estimateHours(stats) })
  const coordination = report.activities
    .filter((a) => a.section === "coordination")
    .reduce((n, a) => n + a.cost, 0)

  const share = coordination / report.totalCost
  strictEqual(
    Math.abs(share - 0.2) < 0.005,
    true,
    `coordination tax is ${(share * 100).toFixed(1)}% of the grand total, not 20%`,
  )

  // The plugin prints that share back to the user. It must compute it from the
  // report it was handed — a literal here goes stale the moment the model is
  // tuned, and the two harnesses start quoting different percentages.
  ok(
    /coordination/i.test(tuiSource),
    "TUI plugin no longer renders the coordination section — update this test",
  )
  ok(
    !/\b20\s*%/.test(tuiSource),
    "TUI plugin hardcodes the 20% coordination share — derive it from the report",
  )
})
