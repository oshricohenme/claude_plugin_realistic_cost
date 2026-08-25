/** @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { JSX } from "solid-js"
import type { TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import {
  applyPathFlags,
  classifyDomain,
  computeCost,
  emptyStats,
  estimateHours,
  formatMoney,
  formatMoneyPrecise,
  formatRate,
  type ActivityCost,
  type CostReport,
  type TranscriptStats,
} from "pre_ai_dev_cost_receipt/core"

// ═══════════════════════════════════════════════════════════════════════════
// SESSION BRIDGE — opencode state → TranscriptStats
//
// This file owns the opencode-specific parts only: reading session state and
// drawing the TUI. Every number comes from the shared engine in
// `realistic-cost/core`, so the sidebar, the CLI and the Claude Code status
// line cannot disagree about what a session cost.
// ═══════════════════════════════════════════════════════════════════════════

interface SessionApi {
  state: {
    session: {
      diff(sessionID: string): { file?: string; additions?: number; deletions?: number }[] | undefined
      messages(sessionID: string): unknown[] | undefined
    }
    part(messageID: string): unknown[] | undefined
  }
}

function buildStatsFromSession(
  api: SessionApi,
  sessionID: string,
): { stats: TranscriptStats; aiCost: number } {
  const stats = emptyStats()

  // 1. Diff → file writes + lines. opencode reports a per-file additions /
  //    deletions summary rather than individual tool inputs, so each changed
  //    file becomes one "Edit"-shaped write op.
  try {
    const diff = api.state.session.diff(sessionID) ?? []
    for (const item of diff) {
      const path = item.file ?? ""
      stats.fileWrites.push({
        path,
        tool: "Edit",
        linesAdded: item.additions ?? 0,
        linesRemoved: item.deletions ?? 0,
        domain: classifyDomain(path),
      })
      stats.linesAdded += item.additions ?? 0
      stats.linesRemoved += item.deletions ?? 0
    }
    applyPathFlags(
      stats,
      stats.fileWrites.map((w) => w.path),
    )
  } catch {
    // A session with no diff yet is normal, not an error.
  }

  // 2. Messages + parts → tool calls, thinking, AI cost, duration.
  let aiCost = 0
  let firstCreated = 0
  let lastCompleted = 0
  try {
    for (const raw of api.state.session.messages(sessionID) ?? []) {
      const msg = raw as {
        info?: { role?: string; id?: string; time?: { created?: number; completed?: number } }
        role?: string
        id?: string
        time?: { created?: number; completed?: number }
      }
      const role = msg.info?.role ?? msg.role
      const created = msg.info?.time?.created ?? msg.time?.created ?? 0
      const completed = msg.info?.time?.completed ?? msg.time?.completed ?? 0
      if (created && (!firstCreated || created < firstCreated)) firstCreated = created
      if (completed && completed > lastCompleted) lastCompleted = completed

      if (role !== "assistant") continue
      stats.assistantTurns += 1
      const msgId = msg.info?.id ?? msg.id
      if (!msgId) continue

      try {
        for (const rawPart of api.state.part(msgId) ?? []) {
          const part = rawPart as { type?: string; tool?: string; text?: string; cost?: number }
          if (part.type === "tool") {
            recordOpencodeTool(stats, part.tool ?? "")
          } else if (part.type === "reasoning") {
            stats.thinkingTurns += 1
            stats.thinkingTokens += Math.ceil((part.text ?? "").length / 4)
          } else if (part.type === "step-finish") {
            aiCost += part.cost ?? 0
          }
        }
      } catch {
        // Parts for an in-flight message may not be readable yet.
      }
    }
  } catch {
    // No session state available — fall through with zeroed stats.
  }

  stats.durationMs = firstCreated && lastCompleted ? lastCompleted - firstCreated : 0
  return { stats, aiCost }
}

/** opencode's tool names, mapped onto the engine's tool-call buckets. */
function recordOpencodeTool(stats: TranscriptStats, tool: string): void {
  stats.toolCalls.total += 1
  switch (tool.toLowerCase()) {
    case "read":
      stats.toolCalls.read += 1
      break
    case "write":
      stats.toolCalls.write += 1
      break
    case "edit":
    case "multiedit":
    case "patch":
      stats.toolCalls.edit += 1
      break
    case "glob":
    case "list":
      stats.toolCalls.glob += 1
      break
    case "grep":
    case "search":
      stats.toolCalls.grep += 1
      break
    case "bash":
    case "pty":
      stats.toolCalls.bash += 1
      break
    case "task":
      stats.toolCalls.task += 1
      break
    default:
      stats.toolCalls.other += 1
      break
  }
}

function buildReport(api: SessionApi, sessionID: string): CostReport | null {
  const { stats, aiCost } = buildStatsFromSession(api, sessionID)
  const nothingHappened =
    stats.fileWrites.length === 0 && stats.linesAdded === 0 && stats.toolCalls.total === 0
  if (nothingHappened) return null
  return computeCost({ stats, estimate: estimateHours(stats), options: { aiCost } })
}

// ═══════════════════════════════════════════════════════════════════════════
// PRESENTATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function pad(str: string, len: number, align: "left" | "right" = "left"): string {
  if (str.length >= len) return str.slice(0, len)
  const spaces = " ".repeat(len - str.length)
  return align === "right" ? spaces + str : str + spaces
}

const money = (n: number, currency: string) => formatMoney(n, currency)
const rateStr = (n: number, currency: string) => formatRate(n, currency)

type Theme = TuiThemeCurrent

interface Section {
  items: ActivityCost[]
  hours: number
  cost: number
}

function sectionOf(report: CostReport, name: ActivityCost["section"]): Section {
  const items = report.activities.filter((a) => a.section === name)
  return {
    items,
    hours: items.reduce((s, a) => s + a.hours, 0),
    cost: items.reduce((s, a) => s + a.cost, 0),
  }
}

function rule(theme: Theme, width: number, ch = "─"): JSX.Element {
  return <text fg={theme.borderSubtle}>{ch.repeat(width)}</text>
}

function receiptLine(
  theme: Theme,
  label: string,
  qty: string,
  rate: string,
  amount: string,
  opts?: { bold?: boolean; muted?: boolean; indent?: boolean },
): JSX.Element {
  const attrs = opts?.bold ? TextAttributes.BOLD : undefined
  const labelFg = opts?.muted ? theme.textMuted : theme.text
  const amountFg = opts?.muted ? theme.textMuted : opts?.bold ? theme.primary : theme.text
  return (
    <box flexDirection="row" gap={1}>
      <text fg={labelFg} attributes={attrs}>
        {pad(opts?.indent ? "  " + label : label, 28)}
      </text>
      <text fg={theme.textMuted} attributes={attrs}>
        {pad(qty, 6, "right")}
      </text>
      <text fg={theme.textMuted} attributes={attrs}>
        {pad(rate, 8, "right")}
      </text>
      <text fg={amountFg} attributes={attrs}>
        {pad(amount, 9, "right")}
      </text>
    </box>
  )
}

function activityRows(theme: Theme, items: ActivityCost[], currency: string, indent = false): JSX.Element[] {
  return items.map((a) =>
    receiptLine(
      theme,
      a.activity,
      a.hours.toFixed(1) + "h",
      rateStr(a.hours > 0 ? a.cost / a.hours : 0, currency),
      money(a.cost, currency),
      { indent, muted: indent },
    ),
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════════════════

const tui: TuiPluginModule["tui"] = async (api) => {
  const [report, setReport] = createSignal<CostReport | null>(null)

  function recompute() {
    try {
      const route = api.route.current
      // The route union has a catch-all member, so `name === "session"` alone
      // does not narrow params — check the field we actually need.
      const sessionID = route?.name === "session" ? route.params?.sessionID : undefined
      if (typeof sessionID !== "string" || !sessionID) {
        setReport(null)
        return
      }
      setReport(buildReport(api as unknown as SessionApi, sessionID))
    } catch {
      setReport(null)
    }
  }

  // Recompute on session/message events, coalesced into one pass per tick.
  let pending = false
  const scheduleRecompute = () => {
    if (pending) return
    pending = true
    queueMicrotask(() => {
      pending = false
      recompute()
    })
  }

  // event.on returns its own unsubscribe function. Without releasing them the
  // listeners survive a plugin reload, and every reload adds another full
  // recompute to each event.
  const unsubscribes = [
    api.event.on("message.updated", scheduleRecompute),
    api.event.on("session.updated", scheduleRecompute),
    api.event.on("session.idle", scheduleRecompute),
  ]
  api.lifecycle.onDispose(() => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  })

  recompute()

  // ── Sidebar footer slot ──
  api.slots.register({
    slots: {
      sidebar_footer: (): JSX.Element => {
        const r = report()
        const theme = api.theme.current
        const W = 26

        if (!r || r.totalCost === 0) {
          return (
            <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={0}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                Pre-AI human engineering cost
              </text>
              <text fg={theme.textMuted}>/realistic-cost → full receipt</text>
            </box>
          )
        }

        const rows: [string, number][] = [
          ["Mgmt Overhead", sectionOf(r, "management").cost],
          ["Value Creation", sectionOf(r, "value").cost],
          ["Coordination Tax", sectionOf(r, "coordination").cost],
        ]

        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={0}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              {pad("Pre-AI Human Cost", W)}
            </text>
            {rule(theme, W)}
            {rows.map(([label, cost]) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.textMuted}>{pad(label, 16)}</text>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  {pad(money(cost, r.currency), 9, "right")}
                </text>
              </box>
            ))}
            {rule(theme, W)}
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {pad("GRAND TOTAL", 16)}
              </text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                {pad(money(r.totalCost, r.currency), 9, "right")}
              </text>
            </box>
            <text fg={theme.textMuted}> </text>
            <text fg={theme.textMuted}>{r.calendar.manDays.toFixed(1) + " man-days"}</text>
            <text fg={theme.textMuted}> </text>
            <text fg={theme.textMuted}>/realistic-cost → full receipt</text>
          </box>
        )
      },
    },
  })

  // ── /realistic-cost slash command → full review dialog ──
  // keymap is not yet part of the published TuiPluginModule typing.
  const keymap = (api as { keymap?: { registerLayer?: (layer: unknown) => void } }).keymap
  if (keymap?.registerLayer) {
    try {
      keymap.registerLayer({
        commands: [
          {
            namespace: "palette",
            name: "realistic-cost.review",
            title: "Pre-AI Cost: Full Receipt",
            desc: "Show what a human engineering team would cost for this session",
            category: "Pre-AI Cost",
            slashName: "realistic-cost",
            slashAliases: ["preai", "pa"],
            run: () => {
              const r = report()
              if (!r || r.totalCost === 0) {
                api.ui.dialog.replace(() => (
                  <box padding={2}>
                    <text fg={api.theme.current.textMuted}>
                      No work detected yet. Start coding to see cost estimates.
                    </text>
                  </box>
                ))
                return
              }
              api.ui.dialog.replace(() => <ReviewDialog report={r} theme={api.theme.current} />)
            },
          },
        ],
      })
    } catch {
      // Slash command unavailable in this opencode version — sidebar still works.
    }
  }
}

// ── Full review dialog — three-section receipt ──

function ReviewDialog(props: { report: CostReport; theme: Theme }): JSX.Element {
  const r = props.report
  const theme = props.theme
  const W = 54

  const mgmt = sectionOf(r, "management")
  const value = sectionOf(r, "value")
  const coord = sectionOf(r, "coordination")
  const coordPct = r.totalCost > 0 ? (coord.cost / r.totalCost) * 100 : 0

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={0} flexDirection="column">
      {rule(theme, W, "═")}
      <box flexDirection="row" justifyContent="center">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {"  Pre-AI Human Engineering Cost  "}
        </text>
      </box>
      <box flexDirection="row" justifyContent="center">
        <text fg={theme.textMuted}>what a real team would charge</text>
      </box>
      {rule(theme, W, "═")}
      <text> </text>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{pad("LINE ITEM", 28)}</text>
        <text fg={theme.textMuted}>{pad("QTY", 6, "right")}</text>
        <text fg={theme.textMuted}>{pad("RATE", 8, "right")}</text>
        <text fg={theme.textMuted}>{pad("AMOUNT", 9, "right")}</text>
      </box>
      {rule(theme, W)}

      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Management Overhead
      </text>
      {rule(theme, W)}
      {activityRows(theme, mgmt.items, r.currency)}
      {rule(theme, W)}
      {receiptLine(
        theme,
        "Mgmt Overhead Subtotal",
        mgmt.hours.toFixed(1) + "h",
        "",
        money(mgmt.cost, r.currency),
        { bold: true },
      )}
      <text> </text>

      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Value Creation
      </text>
      {rule(theme, W)}
      {activityRows(theme, value.items, r.currency)}
      {rule(theme, W)}
      {receiptLine(
        theme,
        "Value Creation Subtotal",
        value.hours.toFixed(1) + "h",
        "",
        money(value.cost, r.currency),
        { bold: true },
      )}
      <text> </text>

      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Coordination Tax
      </text>
      <text fg={theme.textMuted}>meetings, emails, slack, status updates</text>
      {rule(theme, W)}
      {activityRows(theme, coord.items, r.currency, true)}
      {rule(theme, W)}
      {receiptLine(
        theme,
        "Coordination Tax Total",
        coord.hours.toFixed(1) + "h",
        "",
        money(coord.cost, r.currency),
        { bold: true, muted: true },
      )}
      <text fg={theme.textMuted}>
        {"  (" + coordPct.toFixed(0) + "% of grand total is coordination overhead)"}
      </text>
      <text> </text>

      {rule(theme, W, "═")}
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {pad("GRAND TOTAL", 28)}
        </text>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {pad(r.totalHours.toFixed(1) + "h", 6, "right")}
        </text>
        <text fg={theme.textMuted}>{pad("", 8, "right")}</text>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          {pad(money(r.totalCost, r.currency), 9, "right")}
        </text>
      </box>
      {rule(theme, W, "═")}
      <text> </text>

      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Effort:</text>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {r.calendar.manDays.toFixed(1)} man-days
        </text>
        <text fg={theme.textMuted}>·</text>
        <text fg={theme.text}>{r.calendar.humanReadable}</text>
      </box>
      {r.aiCost > 0 ? (
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>AI cost:</text>
          <text fg={theme.success}>{formatMoneyPrecise(r.aiCost, r.currency)}</text>
        </box>
      ) : null}
      <text> </text>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>esc to close</text>
        <text fg={theme.textMuted}>realistic-cost export pdf</text>
      </box>
    </box>
  )
}

export default {
  id: "realistic-cost",
  tui,
} satisfies TuiPluginModule
