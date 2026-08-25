import { readFileSync } from "node:fs"
import { ROLES } from "../core/roles.js"
import type { RoleId } from "../core/types.js"

export interface LoadedRates {
  rates?: Partial<Record<RoleId, number>>
  currency?: string
}

const ROLE_IDS = new Set(Object.keys(ROLES))

/**
 * Read a user rates-override file: either `{ currency?, rates: { ... } }` or a
 * bare `{ "backend": 130, ... }` object.
 *
 * Unknown role names and non-positive rates are reported rather than silently
 * dropped — a typo'd role in a rates file otherwise looks like it worked.
 * Returns `{}` (with a stderr warning) when the file is missing or invalid;
 * callers fall back to defaults.
 */
export function readRatesFile(p?: string): LoadedRates {
  if (!p) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"))
  } catch (err) {
    warn(`cannot read rates file ${p} (${err instanceof Error ? err.message : String(err)}) — using defaults`)
    return {}
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warn(`rates file ${p} is not a JSON object — using defaults`)
    return {}
  }

  const root = parsed as Record<string, unknown>
  const hasRatesKey = typeof root.rates === "object" && root.rates !== null && !Array.isArray(root.rates)
  const source = (hasRatesKey ? root.rates : root) as Record<string, unknown>

  const rates: Partial<Record<RoleId, number>> = {}
  const unknown: string[] = []
  const invalid: string[] = []
  for (const [key, value] of Object.entries(source)) {
    if (!hasRatesKey && (key === "currency" || key === "rates")) continue
    if (!ROLE_IDS.has(key)) {
      unknown.push(key)
      continue
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      invalid.push(key)
      continue
    }
    rates[key as RoleId] = value
  }

  if (unknown.length) warn(`rates file ${p}: unknown role(s) ignored: ${unknown.join(", ")}`)
  if (invalid.length) warn(`rates file ${p}: rate must be a positive number, ignored: ${invalid.join(", ")}`)

  const currency =
    typeof root.currency === "string" && root.currency.trim() ? root.currency.trim() : undefined
  return { rates, currency }
}

function warn(message: string): void {
  process.stderr.write(`realistic-cost: ${message}\n`)
}
