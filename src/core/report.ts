import kleur from "kleur"
import type { CostReport, ActivityCost, ActivitySection } from "./types.js"

export function formatStatusLine(report: CostReport): string {
  const cal = report.calendar
  const cost = report.totalCost
  const hours = report.totalHours
  const ai = report.aiCost > 0 ? ` | AI $${report.aiCost.toFixed(2)}` : ""
  return `${kleur.cyan("Pre-AI")}: $${cost.toFixed(0)} · ${hours.toFixed(1)}h · ${cal.manDays.toFixed(1)} man-days${ai}`
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US")
}

function rateStr(n: number): string {
  if (n <= 0) return "—"
  return "$" + Math.round(n) + "/h"
}

interface SectionTotals {
  items: ActivityCost[]
  hours: number
  cost: number
}

function getSections(activities: ActivityCost[]): Record<ActivitySection, SectionTotals> {
  const sections: ActivitySection[] = ["management", "value", "coordination"]
  const result = {} as Record<ActivitySection, SectionTotals>
  for (const sec of sections) {
    const items = activities.filter((a) => a.section === sec)
    result[sec] = {
      items,
      hours: items.reduce((s, a) => s + a.hours, 0),
      cost: items.reduce((s, a) => s + a.cost, 0),
    }
  }
  return result
}

// The colored terminal receipt lives in src/cli/render.ts (renderTerminal).
// This module keeps only the harness-independent formatters: statusline,
// markdown, HTML.

export function formatMarkdown(report: CostReport): string {
  const cal = report.calendar
  const L: string[] = []
  const sec = getSections(report.activities)
  const grandTotal = report.totalCost
  const coordPct = grandTotal > 0 ? (sec.coordination.cost / grandTotal) * 100 : 0

  L.push("# Pre-AI Human Engineering Cost")
  L.push("")
  L.push("_what a real team would charge_")
  L.push("")
  L.push(`_Generated ${report.generatedAt}_`)
  L.push("")

  const mdTable = (items: ActivityCost[], indent?: boolean) => {
    const rows: string[] = ["| Line Item | Hours | Rate | Amount |", "|---|---:|---:|---:|"]
    for (const a of items) {
      const rate = a.hours > 0 ? a.cost / a.hours : 0
      const lbl = indent ? "  " + a.activity : a.activity
      rows.push(`| ${lbl} | ${a.hours.toFixed(1)}h | ${rateStr(rate)} | ${money(a.cost)} |`)
    }
    return rows.join("\n")
  }

  L.push("## Management Overhead")
  L.push("")
  L.push(mdTable(sec.management.items))
  L.push(`| **Subtotal** | **${sec.management.hours.toFixed(1)}h** | | **${money(sec.management.cost)}** |`)
  L.push("")

  L.push("## Value Creation")
  L.push("")
  L.push(mdTable(sec.value.items))
  L.push(`| **Subtotal** | **${sec.value.hours.toFixed(1)}h** | | **${money(sec.value.cost)}** |`)
  L.push("")

  L.push("## Coordination Tax")
  L.push("")
  L.push("_(meetings, emails, slack, status updates)_")
  L.push("")
  L.push(mdTable(sec.coordination.items, true))
  L.push(`| **Coordination Tax Total** | **${sec.coordination.hours.toFixed(1)}h** | | **${money(sec.coordination.cost)}** |`)
  L.push("")
  L.push(`> ${coordPct.toFixed(0)}% of grand total is coordination overhead`)
  L.push("")

  L.push("## Grand Total")
  L.push("")
  L.push(`| | Hours | Amount |`)
  L.push(`|---|---:|---:|`)
  L.push(`| **GRAND TOTAL** | **${report.totalHours.toFixed(1)}h** | **${money(report.totalCost)}** |`)
  L.push("")
  L.push("## Effort")
  L.push("")
  L.push(`- **${cal.manDays.toFixed(1)} man-days (${cal.humanReadable})**`)
  L.push("")
  if (report.aiCost > 0) {
    L.push(`**AI cost:** $${report.aiCost.toFixed(2)}`)
    L.push("")
  }

  return L.join("\n")
}

export function formatHtml(report: CostReport): string {
  const cal = report.calendar
  const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const sec = getSections(report.activities)
  const grandTotal = report.totalCost
  const coordPct = grandTotal > 0 ? (sec.coordination.cost / grandTotal) * 100 : 0

  const tableRows = (items: ActivityCost[], indent?: boolean) =>
    items.map((a) => {
      const rate = a.hours > 0 ? a.cost / a.hours : 0
      const lbl = indent ? `&nbsp;&nbsp;${esc(a.activity)}` : esc(a.activity)
      return `<tr><td>${lbl}</td><td class="n">${a.hours.toFixed(1)}h</td><td class="n">${rateStr(rate)}</td><td class="n">${money(a.cost)}</td></tr>`
    }).join("\n")

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pre-AI Human Engineering Cost</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem auto; max-width: 720px; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.6rem; }
  h2 { margin-top: 2rem; border-bottom: 1px solid #888; padding-bottom: .25rem; }
  .subtitle { color: #999; font-size: .95rem; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #444; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .total-row { font-weight: 700; }
  .grand { font-size: 1.4rem; font-weight: 800; }
  .note { color: #999; font-style: italic; margin: .5rem 0; }
  .receipt { border: 2px solid #666; border-radius: .5rem; padding: 1.5rem; margin: 1rem 0; }
  .section-label { font-weight: 700; text-transform: uppercase; font-size: .8rem; letter-spacing: .05em; margin: 1rem 0 .25rem; }
  .section-mgmt { color: #c9a227; }
  .section-value { color: #4caf50; }
  .section-coord { color: #aaa; }
</style>
</head>
<body>
<h1>Pre-AI Human Engineering Cost</h1>
<p class="subtitle">what a real team would charge</p>
<p class="note">Generated ${esc(report.generatedAt)}</p>

<div class="receipt">

<p class="section-label section-mgmt">Management Overhead</p>
<table>
<tr><th>Line Item</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr>
${tableRows(sec.management.items)}
<tr class="total-row"><td>Subtotal</td><td class="n">${sec.management.hours.toFixed(1)}h</td><td></td><td class="n">${money(sec.management.cost)}</td></tr>
</table>

<p class="section-label section-value">Value Creation</p>
<table>
<tr><th>Line Item</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr>
${tableRows(sec.value.items)}
<tr class="total-row"><td>Subtotal</td><td class="n">${sec.value.hours.toFixed(1)}h</td><td></td><td class="n">${money(sec.value.cost)}</td></tr>
</table>

<p class="section-label section-coord">Coordination Tax</p>
<p class="note">meetings, emails, slack, status updates</p>
<table>
<tr><th>Line Item</th><th class="n">Hours</th><th class="n">Rate</th><th class="n">Amount</th></tr>
${tableRows(sec.coordination.items, true)}
<tr class="total-row"><td>Coordination Tax Total</td><td class="n">${sec.coordination.hours.toFixed(1)}h</td><td></td><td class="n">${money(sec.coordination.cost)}</td></tr>
</table>
<p class="note">${coordPct.toFixed(0)}% of grand total is coordination overhead</p>

<table>
<tr class="total-row grand"><td>GRAND TOTAL</td><td class="n">${report.totalHours.toFixed(1)}h</td><td></td><td class="n">${money(report.totalCost)}</td></tr>
</table>
</div>

<h2>Effort</h2>
<p><strong>${cal.manDays.toFixed(1)} man-days</strong> (${esc(cal.humanReadable)})</p>
${report.aiCost > 0 ? `<p><strong>AI cost:</strong> $${report.aiCost.toFixed(2)}</p>` : ""}

</body>
</html>`
}
