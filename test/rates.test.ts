import { test } from "node:test"
import { strictEqual, ok, deepStrictEqual } from "node:assert"
import { defaultRates, mergeRates, ROLES } from "../src/core/index.js"
import type { RoleId } from "../src/core/index.js"

test("defaultRates derives from the role table (single source of truth)", () => {
  const rates = defaultRates()
  for (const id of Object.keys(ROLES) as RoleId[]) {
    strictEqual(rates[id], ROLES[id].defaultHourlyRate, `${id} rate matches ROLES`)
  }
})

test("mergeRates does not mutate the base (singleton safety)", () => {
  const base = defaultRates()
  const before = { ...base }
  const merged = mergeRates(base, { backend: 999, qa: -5, em: Number.NaN })
  deepStrictEqual(base, before, "base object unchanged")
  strictEqual(merged.backend, 999)
  strictEqual(merged.qa, before.qa, "non-positive overrides ignored")
  strictEqual(merged.em, before.em, "NaN overrides ignored")
})

test("mergeRates with no overrides returns a copy", () => {
  const base = defaultRates()
  const copy = mergeRates(base)
  deepStrictEqual(copy, base)
  ok(copy !== base, "returns a new object")
})

test("partial overrides keep other roles at defaults", () => {
  const merged = mergeRates(defaultRates(), { backend: 130 })
  strictEqual(merged.backend, 130)
  strictEqual(merged.frontend, defaultRates().frontend)
})
