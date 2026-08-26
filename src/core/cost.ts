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
import { resolveEstimateOptions } from "./estimate.js"

// ---------------------------------------------------------------------------
// Compute cost + calendar from stats + estimate
// ---------------------------------------------------------------------------

const DEFAULT_HOURS_PER_DAY = 8

/**
 * Share of the grand total attributed to the coordination tax — meetings
 * with the EM/PM/DevOps and issue management. A real team spends roughly a
 * fifth of its budget communicating; the receipt makes that visible.
 */
const COORDINATION_TAX_SHARE = 0.2
const COORDINATION_BUCKETS = 4

/**
 * A line item is dropped below this many hours. The receipt prints hours to
 * one decimal, so anything under 0.05h renders as "0.0h" — and a row reading
 * "0.0h ... $312" is a bug report waiting to happen. Because every activity's
 * cost is `hours x a strictly positive rate`, filtering on hours alone also
 * bounds the amount, and section subtotals are summed from the rows that
 * survive this filter, so the printed hours always add up to the printed
 * amounts.
 */
const MIN_DISPLAY_HOURS = 0.05

interface CostOptionsInternal {
  hoursPerDay: number
  aiCost: number
  currency: string
  estimateOptions: Required<EstimateOptions>
}

function resolveOptions(o?: CostOptions): CostOptionsInternal {
  return {
    hoursPerDay: o?.productiveHoursPerDay ?? DEFAULT_HOURS_PER_DAY,
    aiCost: o?.aiCost ?? 0,
    currency: (o?.currency ?? "USD").toUpperCase(),
    // Defaults come from estimate.ts so the receipt and the role model can
    // never be tuned apart.
    estimateOptions: resolveEstimateOptions(o?.estimateOptions),
  }
}

// ---------------------------------------------------------------------------
// Activity breakdown — re-attributes the grand total into non-overlapping
// activity buckets. Derives its numbers from the role estimate (est.roles)
// and the SAME EstimateOptions, so the receipt and the role model cannot
// drift apart.
// ---------------------------------------------------------------------------

type ActivityDraft = Omit<ActivityCost, "percentage">

/**
 * Keep a line item only if it will render as a non-zero quantity. See
 * MIN_DISPLAY_HOURS — this is what stops "0.0h" rows carrying a real amount.
 */
function displayable(items: ActivityDraft[]): ActivityDraft[] {
  return items.filter((a) => a.hours >= MIN_DISPLAY_HOURS)
}

function computeActivities(
  stats: TranscriptStats,
  est: EstimateResult,
  rates: Record<RoleId, number>,
  o: Required<EstimateOptions>,
): ActivityCost[] {
  // Taken from the estimate rather than recomputed: this used to restate the
  // formula, which is exactly how a receipt drifts from the role model it is
  // supposed to describe.
  const toolWorkHours = est.toolWorkHours
  const comprehensionHours = est.comprehensionHours
  const reMap = new Map(est.roles.map((r) => [r.role, r]))
  const implH = (id: RoleId) => reMap.get(id)?.implementationHours ?? 0
  const ohH = (id: RoleId) => reMap.get(id)?.overheadHours ?? 0

  const BE = implH("backend"),
    FE = implH("frontend"),
    FS = implH("fullstack")
  const DEVOPS_I = implH("devops"),
    QA_I = implH("qa"),
    DATA_I = implH("data")
  const DESIGN_I = implH("designer")

  const codingTotalCost =
    BE * rates.backend +
    FE * rates.frontend +
    FS * rates.fullstack +
    DEVOPS_I * rates.devops +
    DATA_I * rates.data +
    QA_I * rates.qa
  const codingTotalHours = BE + FE + FS + DEVOPS_I + DATA_I + QA_I

  /**
   * The rate used to convert a cost back into billable hours (thinking,
   * coordination). It is the session's actual engineering blend when there was
   * engineering work, and the plain average of the engineering rates when
   * there was none — a read-only or pure-reasoning session still buys a
   * senior engineer's time, and dividing by zero used to yield line items that
   * printed "0.0h" next to a four-figure amount.
   */
  const engAverageRate = (rates.backend + rates.frontend + rates.fullstack) / 3
  const blendedRate = codingTotalHours > 0 ? codingTotalCost / codingTotalHours : engAverageRate

  // Tool work and comprehension were folded into the engineering roles'
  // implementation hours, so subtracting them back out leaves the hours that
  // came from lines of code.
  const nonCoding = toolWorkHours + comprehensionHours
  let codingHours = codingTotalHours - nonCoding
  let codingCost = codingTotalCost - nonCoding * blendedRate
  if (codingHours <= 0.01 && stats.toolCalls.write + stats.toolCalls.edit > 0) {
    codingHours = stats.toolCalls.write * 0.5 + stats.toolCalls.edit * 0.3
    codingCost = codingHours * blendedRate
  }

  const thinkingCost = stats.thinkingTokens * o.thinkingCostPerToken
  const designHours = DESIGN_I + o.designOverheadMultiplier * (FE + FS)
  const deployHours = o.devopsDeployMultiplier * (BE + FE + FS)
  const valueActs = displayable([
    { activity: "Thinking", hours: thinkingCost / blendedRate, cost: thinkingCost, section: "value" },
    {
      activity: "Tool Work",
      hours: toolWorkHours,
      cost: toolWorkHours * blendedRate,
      section: "value",
    },
    {
      activity: "Code Comprehension",
      hours: comprehensionHours,
      cost: comprehensionHours * blendedRate,
      section: "value",
    },
    // Work the OTHER department actually performed to satisfy our MCP calls.
    // Value creation — someone did it — but not by our team.
    {
      activity: "Other Dept Work (MCP)",
      hours: est.mcpDepartmentWorkHours,
      cost: est.mcpDepartmentWorkHours * blendedRate,
      section: "value",
    },
    { activity: "Coding", hours: codingHours, cost: codingCost, section: "value" },
    { activity: "Design", hours: designHours, cost: designHours * rates.designer, section: "value" },
    {
      activity: "Peer Review",
      hours: o.reviewOverheadMultiplier * (BE + FE + FS + DEVOPS_I + DATA_I),
      cost:
        o.reviewOverheadMultiplier *
        (BE * rates.backend +
          FE * rates.frontend +
          FS * rates.fullstack +
          DEVOPS_I * rates.devops +
          DATA_I * rates.data),
      section: "value",
    },
    { activity: "QA & Testing", hours: ohH("qa"), cost: ohH("qa") * rates.qa, section: "value" },
    // The technical writer's whole role: docs the session wrote, plus review
    // and the changelog/API-doc overhead. Unlike every other engineering role,
    // none of it is folded into Coding or Peer Review — those cover
    // BE/FE/FS/devops/data/qa only — so without this line documentation work
    // is priced at zero in the receipt while still showing in the roles table.
    {
      activity: "Documentation",
      hours: implH("techwriter") + ohH("techwriter"),
      cost: (implH("techwriter") + ohH("techwriter")) * rates.techwriter,
      section: "value",
    },
    { activity: "DevOps & Infra", hours: deployHours, cost: deployHours * rates.devops, section: "value" },
    {
      activity: "Security Review",
      hours: ohH("security"),
      cost: ohH("security") * rates.security,
      section: "value",
    },
  ])

  // Management — taken verbatim from the role estimate's PM and EM totals
  // (max(3h, overhead x implHours)), so the receipt and the roles table
  // always agree on management cost.
  const pmCost = ohH("pm") * rates.pm
  const emCost = ohH("em") * rates.em
  const mgmtActs = displayable([
    { activity: "Product Management", hours: ohH("pm"), cost: pmCost, section: "management" },
    { activity: "Engineering Management", hours: ohH("em"), cost: emCost, section: "management" },
  ])

  // Coordination tax — COORDINATION_TAX_SHARE of the grand total, split
  // evenly across buckets. Grand total T satisfies
  // T = X + pmCost + emCost + COORDINATION_TAX_SHARE * T.
  const X = valueActs.reduce((s, a) => s + a.cost, 0)
  const mgmtTotal = mgmtActs.reduce((s, a) => s + a.cost, 0)
  const T = (X + mgmtTotal) / (1 - COORDINATION_TAX_SHARE)
  const bucketCost = (COORDINATION_TAX_SHARE * T) / COORDINATION_BUCKETS
  const bucketHours = bucketCost / blendedRate
  // Per-tool-call email and meeting time sits ON TOP of the flat tax: the tax
  // is the standing cost of being on a team, this is the correspondence a
  // specific piece of work generates. Adding it to the tax base instead would
  // compound coordination onto coordination.
  const toolCoordHours = est.toolCoordinationHours
  const coordActs = displayable([
    { activity: "Meeting w/ Eng Manager", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Meeting w/ PM", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Meeting w/ DevOps", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Issue Management", hours: bucketHours, cost: bucketCost, section: "coordination" },
    {
      activity: "Emails & Follow-ups",
      hours: toolCoordHours,
      cost: toolCoordHours * blendedRate,
      section: "coordination",
    },
    // Cross-team lines. Both are "another team" costs: the standing tax above
    // covers your own team's meetings, these cover everyone else's.
    {
      activity: "Cross-Team Sync (MCP)",
      hours: est.mcpCoordinationHours,
      cost: est.mcpCoordinationHours * blendedRate,
      section: "coordination",
    },
    {
      activity: "Subagent Team Coordination",
      hours: est.subagentCoordinationHours,
      cost: est.subagentCoordinationHours * blendedRate,
      section: "coordination",
    },
    // The dev sits in the cross-department meetings too. Engineering time that
    // generates nothing, so it belongs here rather than in Value Creation.
    // Priced at the rates of the roles that actually carry these hours, not at
    // the blended rate: these hours also sit in those roles' overhead, and the
    // receipt and the roles table must not disagree about the same cost.
    {
      activity: "Eng in Cross-Dept Meetings",
      hours: est.mcpEngineeringHours,
      cost: Object.entries(est.mcpEngineeringHoursByRole).reduce(
        (sum, [role, hours]) => sum + (hours ?? 0) * rates[role as RoleId],
        0,
      ),
      section: "coordination",
    },
  ])

  const acts = [...mgmtActs, ...valueActs, ...coordActs]

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
    currency: o.currency,
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
