import { readFileSync } from "node:fs"
import type { RoleId } from "../core/types.js"

/**
 * Read a user rates-override file: either `{ rates: { ... } }` or a bare
 * `{ "backend": 130, ... }` object. Returns undefined (with a stderr warning)
 * when the file is missing or invalid — callers fall back to defaults.
 */
export function readRatesFile(p?: string): Partial<Record<RoleId, number>> | undefined {
  if (!p) return undefined
  try {
    const raw = readFileSync(p, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === "object") {
      if (parsed.rates && typeof parsed.rates === "object") {
        return parsed.rates as Partial<Record<RoleId, number>>
      }
      return parsed as Partial<Record<RoleId, number>>
    }
    process.stderr.write(`realistic-cost: rates file ${p} is not a JSON object — using defaults\n`)
    return undefined
  } catch (err) {
    process.stderr.write(
      `realistic-cost: cannot read rates file ${p} (${err instanceof Error ? err.message : String(err)}) — using defaults\n`,
    )
    return undefined
  }
}
