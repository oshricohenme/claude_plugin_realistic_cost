import type {
  ActivityCost,
  ActivitySection,
  CalendarEstimate,
  CostOptions,
  CostReport,
  EstimateOptions,
  EstimateResult,
  RoleCost,
  RoleId,
  TranscriptStats,
} from "./types.js"
import { ROLES, ROLE_ORDER } from "./roles.js"
import { defaultRates, mergeRates } from "./rates.js"

// ---------------------------------------------------------------------------
// Compute cost + calendar from stats + estimate
// ---------------------------------------------------------------------------

const DEFAULT_HOURS_PER_DAY = 8

/**
 * Thinking is billed by reasoning-token volume, not turns: deep reasoning on
 * a hard problem is what a senior engineer's (billable) thinking time maps
 * to. Calibrated so 10k reasoning tokens ≈ a focused half-day of human
 * design/analysis at a ~$100/h blended rate.
 */
const THINKING_COST_PER_TOKEN = 0.05

/**
 * Share of the grand total attributed to the coordination tax — meetings
 * with the EM/PM/DevOps and issue management. A real team spends roughly a
 * fifth of its budget communicating; the receipt makes that visible.
 */
const COORDINATION_TAX_SHARE = 0.2
const COORDINATION_BUCKETS = 4

interface CostOptionsInternal {
  hoursPerDay: number
  aiCost: number
  estimateOptions: Required<EstimateOptions>
}

function resolveOptions(o?: CostOptions): CostOptionsInternal {
  return {
    hoursPerDay: o?.productiveHoursPerDay ?? DEFAULT_HOURS_PER_DAY,
    aiCost: o?.aiCost ?? 0,
    estimateOptions: {
      reviewOverheadMultiplier: 0.35,
      qaOverheadMultiplier: 0.5,
      qaWithTestsMultiplier: 0.35,
      designOverheadMultiplier: 0.6,
      pmOverheadMultiplier: 0.15,
      emOverheadMultiplier: 0.10,
      devopsDeployMultiplier: 0.15,
      securitySensitiveMultiplier: 0.15,
      securityNormalMultiplier: 0.05,
      techwriterOverheadMultiplier: 0.1,
      discoverySearchHours: 0.25,
      discoveryReadHours: 0.15,
      discoveryThinkingHours: 0.1,
      ...o?.estimateOptions,
    },
  }
}

// ---------------------------------------------------------------------------
// Activity breakdown — re-attributes the grand total into non-overlapping
// activity buckets. Derives its numbers from the role estimate (est.roles)
// and the SAME EstimateOptions, so the receipt and the role model cannot
// drift apart.
// ---------------------------------------------------------------------------

function computeActivities(
  stats: TranscriptStats,
  est: EstimateResult,
  rates: Record<RoleId, number>,
  o: Required<EstimateOptions>,
): ActivityCost[] {
  const searchReadHours =
    (stats.toolCalls.glob + stats.toolCalls.grep) * o.discoverySearchHours +
    stats.toolCalls.read * o.discoveryReadHours
  const engineerReadHours = searchReadHours * 0.5

  const reMap = new Map(est.roles.map((r) => [r.role, r]))
  const implH = (id: RoleId) => reMap.get(id)?.implementationHours ?? 0
  const ohH = (id: RoleId) => reMap.get(id)?.overheadHours ?? 0

  const BE = implH("backend"), FE = implH("frontend"), FS = implH("fullstack")
  const DEVOPS_I = implH("devops"), QA_I = implH("qa")
  const DESIGN_I = implH("designer")

  const codingTotalCost = BE * rates.backend + FE * rates.frontend + FS * rates.fullstack + DEVOPS_I * rates.devops + QA_I * rates.qa
  const codingTotalHours = BE + FE + FS + DEVOPS_I + QA_I
  const blendedRate = codingTotalHours > 0 ? codingTotalCost / codingTotalHours : 0

  let codingHours = codingTotalHours - engineerReadHours
  let codingCost = codingTotalCost - engineerReadHours * blendedRate
  if (codingHours <= 0.01 && (stats.toolCalls.write + stats.toolCalls.edit) > 0) {
    codingHours = stats.toolCalls.write * 0.5 + stats.toolCalls.edit * 0.3
    codingCost = codingHours * blendedRate
  }

  const thinkingCost = stats.thinkingTokens * THINKING_COST_PER_TOKEN
  const valueActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = ([
    { activity: "Thinking", hours: blendedRate > 0 ? thinkingCost / blendedRate : 0, cost: thinkingCost, section: "value" as const },
    { activity: "Code Comprehension", hours: engineerReadHours, cost: engineerReadHours * blendedRate, section: "value" as const },
    { activity: "Coding", hours: codingHours, cost: codingCost, section: "value" as const },
    { activity: "Design", hours: DESIGN_I + o.designOverheadMultiplier * (FE + FS), cost: (DESIGN_I + o.designOverheadMultiplier * (FE + FS)) * rates.designer, section: "value" as const },
    { activity: "Peer Review", hours: o.reviewOverheadMultiplier * (BE + FE + FS + DEVOPS_I), cost: o.reviewOverheadMultiplier * (BE * rates.backend + FE * rates.frontend + FS * rates.fullstack + DEVOPS_I * rates.devops), section: "value" as const },
    { activity: "QA & Testing", hours: ohH("qa"), cost: ohH("qa") * rates.qa, section: "value" as const },
    { activity: "DevOps & Infra", hours: o.devopsDeployMultiplier * (BE + FE + FS), cost: o.devopsDeployMultiplier * (BE + FE + FS) * rates.devops, section: "value" as const },
    { activity: "Security Review", hours: ohH("security"), cost: ohH("security") * rates.security, section: "value" as const },
  ] as { activity: string; hours: number; cost: number; section: ActivitySection }[]).filter((a) => a.hours > 0.01 || a.cost > 0.01)

  // Management — taken verbatim from the role estimate's PM and EM totals
  // (max(3h, overhead x implHours)), so the receipt and the roles table
  // always agree on management cost.
  const pmCost = ohH("pm") * rates.pm
  const emCost = ohH("em") * rates.em
  const mgmtActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = [
    { activity: "Product Management", hours: ohH("pm"), cost: pmCost, section: "management" },
    { activity: "Engineering Management", hours: ohH("em"), cost: emCost, section: "management" },
  ]

  // Coordination tax — COORDINATION_TAX_SHARE of the grand total, split
  // evenly across buckets. Grand total T satisfies
  // T = X + pmCost + emCost + COORDINATION_TAX_SHARE * T.
  const X = valueActs.reduce((s, a) => s + a.cost, 0)
  const T = (X + pmCost + emCost) / (1 - COORDINATION_TAX_SHARE)
  const bucketCost = (COORDINATION_TAX_SHARE * T) / COORDINATION_BUCKETS
  const bucketHours = blendedRate > 0 ? bucketCost / blendedRate : 0
  const coordActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = ([
    { activity: "Meeting w/ Eng Manager", hours: bucketHours, cost: bucketCost, section: "coordination" as const },
    { activity: "Meeting w/ PM", hours: bucketHours, cost: bucketCost, section: "coordination" as const },
    { activity: "Meeting w/ DevOps", hours: bucketHours, cost: bucketCost, section: "coordination" as const },
    { activity: "Issue Management", hours: bucketHours, cost: bucketCost, section: "coordination" as const },
  ] as { activity: string; hours: number; cost: number; section: ActivitySection }[]).filter((a) => a.hours > 0.01 || a.cost > 0.01)

  const acts = [...mgmtActs, ...valueActs, ...coordActs]
    .filter((a) => a.hours > 0.01 || a.cost > 0.01)

  const total = acts.reduce((s, a) => s + a.cost, 0)
  return acts
    .map((a) => ({ ...a, percentage: total > 0 ? (a.cost / total) * 100 : 0 }))
    .sort((a, b) => {
      const order: Record<ActivitySection, number> = { management: 0, value: 1, coordination: 2 }
      if (order[a.section] !== order[b.section]) return order[a.section] - order[b.section]
      return b.cost - a.cost
    })
}

export function computeCost(input: {
  stats: TranscriptStats
  estimate: EstimateResult
  rates?: Partial<Record<RoleId, number>>
  options?: CostOptions
}): CostReport {
  const { stats, estimate } = input
  const rates = mergeRates(defaultRates(), input.rates)
  const o = resolveOptions(input.options)

  // Role costs — a per-role VIEW of the same work. Percentages are relative
  // to the grand total (activities include the cross-role coordination tax,
  // which no single role owns, so role percentages sum to ~80%, not 100%).
  const roleById = new Map(estimate.roles.map((r) => [r.role, r]))
  const roles: RoleCost[] = []

  const activities = computeActivities(stats, estimate, rates, o.estimateOptions)
  const totalCost = activities.reduce((s, a) => s + a.cost, 0)
  const totalHours = activities.reduce((s, a) => s + a.hours, 0)

  for (const id of ROLE_ORDER) {
    const re = roleById.get(id)
    const hours = re?.totalHours ?? 0
    const rate = rates[id]
    const cost = hours * rate
    roles.push({
      role: id,
      title: ROLES[id].title,
      category: ROLES[id].category,
      hours,
      hourlyRate: rate,
      cost,
      percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
    })
  }

  const calendar = computeCalendar(totalHours, o)

  return {
    stats,
    estimate,
    roles,
    activities,
    totalCost,
    totalHours,
    calendar,
    generatedAt: new Date().toISOString(),
    rates,
    aiCost: o.aiCost,
    aiDurationMs: stats.durationMs,
    aiLinesAdded: stats.linesAdded,
    aiLinesRemoved: stats.linesRemoved,
  }
}

// ---------------------------------------------------------------------------
// Calendar — man-days (total effort / hours per day)
// ---------------------------------------------------------------------------

function computeCalendar(totalHours: number, o: CostOptionsInternal): CalendarEstimate {
  const manDays = totalHours / o.hoursPerDay
  return {
    manDays,
    humanReadable: humanizeManDays(manDays, o.hoursPerDay),
  }
}

function humanizeManDays(days: number, hoursPerDay: number): string {
  if (days < 1) {
    const h = Math.round(days * hoursPerDay)
    if (h <= 0) return "less than 1 hour"
    return `${h} hour${h === 1 ? "" : "s"}`
  }
  if (days < 5) return `${days.toFixed(1)} man-days`
  const weeks = Math.floor(days / 5)
  const remDays = Math.round(days - weeks * 5)
  const parts: string[] = []
  if (weeks > 0) parts.push(`${weeks} week${weeks === 1 ? "" : "s"}`)
  if (remDays > 0) parts.push(`${remDays} man-day${remDays === 1 ? "" : "s"}`)
  return parts.join(", ")
}

// Section-based activity filtering (replaces old DIRECT_ACTIVITIES)
export function filterActivities(activities: ActivityCost[], section: ActivitySection): ActivityCost[] {
  return activities.filter((a) => a.section === section)
}
