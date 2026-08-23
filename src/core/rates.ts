import type { RoleId } from "./types.js"
import { ROLES } from "./roles.js"

export interface RateConfig {
  currency: string
  rates: Partial<Record<RoleId, number>>
}

let cachedDefault: Record<RoleId, number> | null = null

/**
 * Default hourly rates, derived from the role table in roles.ts (the single
 * source of truth — user overrides come via `--rates <file>`, never a second
 * shipped config file).
 */
export function defaultRates(): Record<RoleId, number> {
  if (cachedDefault) return cachedDefault
  const out = {} as Record<RoleId, number>
  for (const id of Object.keys(ROLES) as RoleId[]) {
    out[id] = ROLES[id].defaultHourlyRate
  }
  cachedDefault = out
  return out
}

export function mergeRates(
  base: Record<RoleId, number>,
  overrides?: Partial<Record<RoleId, number>>,
): Record<RoleId, number> {
  const out = { ...base }
  if (!overrides) return out
  for (const id of Object.keys(overrides) as RoleId[]) {
    const v = overrides[id]
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      out[id] = v
    }
  }
  return out
}
