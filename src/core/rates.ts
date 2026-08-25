import type { RoleId } from "./types.js"
import { ROLES } from "./roles.js"

export interface RateConfig {
  currency: string
  rates: Partial<Record<RoleId, number>>
}

/**
 * Default hourly rates, derived from the role table in roles.ts (the single
 * source of truth — user overrides come via `--rates <file>`, never a second
 * shipped config file).
 *
 * Returns a fresh object every call. An earlier version cached and returned
 * one shared object, which any caller could mutate into every later estimate.
 */
export function defaultRates(): Record<RoleId, number> {
  const out = {} as Record<RoleId, number>
  for (const id of Object.keys(ROLES) as RoleId[]) {
    out[id] = ROLES[id].defaultHourlyRate
  }
  return out
}

/**
 * Overlay user rates on the defaults. Only known roles with a finite positive
 * rate are applied, so a malformed override file can never introduce a NaN or
 * a phantom role into the rate table.
 */
export function mergeRates(
  base: Record<RoleId, number>,
  overrides?: Partial<Record<RoleId, number>>,
): Record<RoleId, number> {
  const out = { ...base }
  if (!overrides) return out
  for (const id of Object.keys(overrides) as RoleId[]) {
    if (!(id in ROLES)) continue
    const v = overrides[id]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[id] = v
    }
  }
  return out
}
