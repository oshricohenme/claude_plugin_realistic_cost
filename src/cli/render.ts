import kleur from "kleur"
import type { CostReport } from "../core/types.js"
import { filterActivities } from "../core/cost.js"
import { formatMoney, formatMoneyPrecise, formatRate } from "../core/report.js"

const W = 72

function pad(str: string, len: number, align: "left" | "right" = "left"): string {
  if (str.length >= len) return str.slice(0, len)
  const fill = " ".repeat(len - str.length)
  return align === "right" ? fill + str : str + fill
}

function receiptLine(
  label: string,
  qty: string,
  rate: string,
  amount: string,
  opts?: { bold?: boolean; muted?: boolean; indent?: boolean },
): string {
  const lbl = opts?.indent ? "  " + label : label
  const amountCol = opts?.bold
    ? kleur.bold().green(pad(amount, 12, "right"))
    : opts?.muted
      ? kleur.gray(pad(amount, 12, "right"))
      : kleur.green(pad(amount, 12, "right"))
  const qtyCol = kleur.gray(pad(qty, 7, "right"))
  const rateCol = kleur.gray(pad(rate, 9, "right"))
  const lblCol = opts?.muted ? kleur.gray(pad(lbl, 36)) : opts?.bold ? kleur.bold(pad(lbl, 36)) : pad(lbl, 36)
  return `  ${lblCol} ${qtyCol} ${rateCol} ${amountCol}`
}

function sectionSubtotal(
  label: string,
  hours: number,
  amount: string,
  opts?: { bold?: boolean; muted?: boolean },
): string {
  return receiptLine(label, hours.toFixed(1) + "h", "", amount, opts)
}

export function renderTerminal(report: CostReport): string {
  const cal = report.calendar
  const money = (n: number) => formatMoney(n, report.currency)
  const rateStr = (n: number) => formatRate(n, report.currency)
  const L: string[] = []

  const mgmt = filterActivities(report.activities, "management")
  const value = filterActivities(report.activities, "value")
  const coord = filterActivities(report.activities, "coordination")

  const mgmtHours = mgmt.reduce((s, a) => s + a.hours, 0)
  const mgmtCost = mgmt.reduce((s, a) => s + a.cost, 0)
  const valueHours = value.reduce((s, a) => s + a.hours, 0)
  const valueCost = value.reduce((s, a) => s + a.cost, 0)
  const coordHours = coord.reduce((s, a) => s + a.hours, 0)
  const coordCost = coord.reduce((s, a) => s + a.cost, 0)
  const grandTotal = report.totalCost
  const coordPct = grandTotal > 0 ? (coordCost / grandTotal) * 100 : 0

  // Receipt header
  L.push(kleur.cyan("═".repeat(W)))
  L.push(kleur.bold().cyan("  Pre-AI Human Engineering Cost"))
  L.push(kleur.gray("  what a real team would charge"))
  L.push(kleur.cyan("═".repeat(W)))
  L.push("")

  // Column header
  L.push(
    `  ${kleur.gray(pad("LINE ITEM", 36))} ${kleur.gray(pad("QTY", 7, "right"))} ${kleur.gray(pad("RATE", 9, "right"))} ${kleur.gray(pad("AMOUNT", 12, "right"))}`,
  )
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)

  // Section 1: Management Overhead
  L.push(`  ${kleur.bold().yellow("Management Overhead")}`)
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  for (const a of mgmt) {
    const rate = a.hours > 0 ? a.cost / a.hours : 0
    L.push(receiptLine(a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost)))
  }
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  L.push(sectionSubtotal("Management Overhead Subtotal", mgmtHours, money(mgmtCost), { bold: true }))
  L.push("")

  // Section 2: Value Creation
  L.push(`  ${kleur.bold().green("Value Creation")}`)
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  for (const a of value) {
    const rate = a.hours > 0 ? a.cost / a.hours : 0
    L.push(receiptLine(a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost)))
  }
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  L.push(sectionSubtotal("Value Creation Subtotal", valueHours, money(valueCost), { bold: true }))
  L.push("")

  // Section 3: Coordination Tax
  L.push(`  ${kleur.bold().gray("Coordination Tax")}`)
  L.push(`  ${kleur.gray("(meetings, emails, slack, status updates)")}`)
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  for (const a of coord) {
    const rate = a.hours > 0 ? a.cost / a.hours : 0
    L.push(
      receiptLine(a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost), {
        indent: true,
        muted: true,
      }),
    )
  }
  L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
  L.push(sectionSubtotal("Coordination Tax Total", coordHours, money(coordCost), { bold: true, muted: true }))
  L.push(`  ${kleur.gray(`  (${coordPct.toFixed(0)}% of grand total is coordination overhead)`)}`)
  L.push("")

  // Grand total
  L.push(kleur.cyan("═".repeat(W)))
  L.push(
    `  ${kleur.bold(pad("GRAND TOTAL", 36))} ${kleur.bold(pad(report.totalHours.toFixed(1) + "h", 7, "right"))} ${kleur.gray(pad("", 9, "right"))} ${kleur.bold().cyan(pad(money(report.totalCost), 12, "right"))}`,
  )
  L.push(kleur.cyan("═".repeat(W)))
  L.push("")

  // Footer
  // humanReadable is often literally "N man-days" — only append it when it
  // says something the man-day figure doesn't (e.g. "2 weeks, 3 man-days").
  const manDays = `${cal.manDays.toFixed(1)} man-days`
  const extra = cal.humanReadable === manDays ? "" : ` ${kleur.gray("·")} ${cal.humanReadable}`
  L.push(`  ${kleur.gray("Effort:")} ${kleur.bold().yellow(manDays)}${extra}`)
  if (report.aiCost > 0) {
    L.push(`  ${kleur.gray("AI cost:")} ${kleur.green(formatMoneyPrecise(report.aiCost, report.currency))}`)
  }
  L.push("")

  // Per-role view — the same work, split by who would have done it. Roles
  // exclude the cross-role coordination tax, so this section sums to less
  // than the grand total; that is stated rather than left to be discovered.
  const staffed = report.roles.filter((r) => r.hours >= 0.05)
  if (staffed.length > 0) {
    L.push(`  ${kleur.bold().cyan("Who Would Have Done It")}`)
    L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
    for (const r of staffed) {
      L.push(receiptLine(r.title, r.hours.toFixed(1) + "h", rateStr(r.hourlyRate), money(r.cost)))
    }
    const staffedCost = staffed.reduce((sum, r) => sum + r.cost, 0)
    L.push(`  ${kleur.gray("─".repeat(W - 2))}`)
    L.push(
      sectionSubtotal(
        "Direct Role Cost",
        staffed.reduce((sum, r) => sum + r.hours, 0),
        money(staffedCost),
        { bold: true },
      ),
    )
    L.push(`  ${kleur.gray(`  (excludes the coordination tax, which no single role owns)`)}`)
    L.push("")
  }

  // Metadata
  const s = report.stats
  L.push(
    `  ${kleur.gray("Lines:")} +${report.aiLinesAdded} / -${report.aiLinesRemoved}  ${kleur.gray("Tools:")} ${s.toolCalls.total}  ${kleur.gray("Thinking:")} ${s.thinkingTurns}`,
  )
  if (s.touchesAuth || s.touchesData || s.touchesInfra) {
    const flags: string[] = []
    if (s.touchesAuth) flags.push(kleur.red("auth"))
    if (s.touchesData) flags.push(kleur.red("data"))
    if (s.touchesInfra) flags.push(kleur.red("infra"))
    L.push(`  ${kleur.gray("Flags:")} ${flags.join(", ")}`)
  }
  L.push("")

  return L.join("\n")
}
