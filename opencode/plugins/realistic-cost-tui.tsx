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

import {
  emptySubagentTotals,
  fetchSubagentTotals,
  mergeSubagents,
  recordParts,
  spanOf,
  widen,
  type OpencodeClient,
  type SubagentTotals,
  type Window,
} from "./subagents.ts"

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
    readonly path: { directory: string }
    /** Configured MCP servers — the only reliable way to tell an MCP call
     *  from a builtin here, since opencode flattens both to `name_tool`. */
    mcp(): readonly { name?: string }[]
    session: {
      diff(sessionID: string): { file?: string; additions?: number; deletions?: number }[] | undefined
      messages(sessionID: string): unknown[] | undefined
    }
    part(messageID: string): unknown[] | undefined
  }
  /**
   * The opencode SDK client. It talks to the opencode server, which reads
   * straight from session storage — so unlike `api.state`, it can see sessions
   * the TUI has never opened. Subagent numbers depend on this, not on the UI.
   *
   * Taken from the real plugin API type rather than hand-rolled: `api` reaches
   * this bridge through a cast, which would happily hide a signature change,
   * and a signature change here means subagent work silently stops being
   * counted. Better a build error than a quietly halved bill.
   */
  client: OpencodeClient
}

/** Names of the MCP servers opencode currently has configured. */
function mcpServerNames(api: SessionApi): string[] {
  try {
    return (api.state.mcp() ?? []).map((m) => m?.name ?? "").filter((n) => n.length > 0)
  } catch {
    return []
  }
}

function buildStatsFromSession(
  api: SessionApi,
  sessionID: string,
): { stats: TranscriptStats; aiCost: number; window: Window } {
  const stats = emptyStats()
  const mcpServers = mcpServerNames(api)

  // 1. Diff → file writes + lines. opencode reports a per-file additions /
  //    deletions summary rather than individual tool inputs, so each changed
  //    file becomes one "Edit"-shaped write op. This is the whole worktree, so
  //    it already includes what subagents wrote (see SubagentTotals).
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

  // 2. Messages + parts → tool calls, thinking, AI cost, duration. Parent
  //    session only; subagents are fetched separately and asynchronously.
  const window: Window = { first: 0, last: 0 }
  let aiCost = 0
  try {
    for (const raw of api.state.session.messages(sessionID) ?? []) {
      const msg = raw as {
        info?: { role?: string; id?: string; time?: { created?: number; completed?: number } }
        role?: string
        id?: string
        time?: { created?: number; completed?: number }
      }
      const role = msg.info?.role ?? msg.role
      widen(window, msg.info?.time ?? msg.time)

      if (role !== "assistant") continue
      stats.assistantTurns += 1
      const msgId = msg.info?.id ?? msg.id
      if (!msgId) continue

      try {
        aiCost += recordParts(stats, api.state.part(msgId) ?? [], mcpServers)
      } catch {
        // Parts for an in-flight message may not be readable yet.
      }
    }
  } catch {
    // No session state available — fall through with zeroed stats.
  }
  // Files this session only read never appear in the diff, but still decide
  // whether the work counts as security-sensitive.
  applyPathFlags(stats, stats.filesReadPaths)

  stats.durationMs = spanOf(window)
  return { stats, aiCost, window }
}

function buildReport(api: SessionApi, sessionID: string, subs: SubagentTotals): CostReport | null {
  const { stats, aiCost, window } = buildStatsFromSession(api, sessionID)
  mergeSubagents(stats, subs, window)
  const nothingHappened =
    stats.fileWrites.length === 0 && stats.linesAdded === 0 && stats.toolCalls.total === 0
  if (nothingHappened) return null
  return computeCost({
    stats,
    estimate: estimateHours(stats),
    options: { aiCost: aiCost + subs.aiCost },
  })
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

/**
 * How often the subagent walk may re-query the server while a session is
 * running. `message.updated` fires many times a second; refetching every
 * child session that often would be the most expensive thing this plugin
 * does. Every idle event forces a refresh regardless, so the final number is
 * always current.
 */
const SUBAGENT_REFRESH_MS = 4000

const tui: TuiPluginModule["tui"] = async (api) => {
  const [report, setReport] = createSignal<CostReport | null>(null)

  // Subagent totals per session, so switching sessions never shows another
  // session's numbers and switching back does not start from zero.
  const subagentsBySession = new Map<string, SubagentTotals>()
  // Throttle per session, not globally: switching sessions must never be
  // throttled away by a fetch that belonged to the session you just left.
  const lastFetchBySession = new Map<string, number>()
  let subagentFetchInFlight = false
  let forceAfterInFlight = ""

  function currentSessionID(): string {
    // The route union has a catch-all member, so `name === "session"` alone
    // does not narrow params — check the field we actually need.
    const route = api.route.current
    const sessionID = route?.name === "session" ? route.params?.sessionID : undefined
    return typeof sessionID === "string" ? sessionID : ""
  }

  function render(sessionID: string) {
    try {
      const subs = subagentsBySession.get(sessionID) ?? emptySubagentTotals()
      setReport(buildReport(api as unknown as SessionApi, sessionID, subs))
    } catch {
      setReport(null)
    }
  }

  /**
   * Re-read this session's subagents from the server and re-render. Throttled
   * unless `force`; a failure keeps the last known totals rather than dropping
   * subagent work back to zero.
   */
  async function refreshSubagents(sessionID: string, force: boolean) {
    if (!sessionID) return
    if (subagentFetchInFlight) {
      // A forced refresh must not be lost to a throttled one already running:
      // that in-flight fetch may have started before the subagents finished,
      // and idle is the moment the totals become final. Re-run it after.
      if (force) forceAfterInFlight = sessionID
      return
    }
    const now = Date.now()
    if (!force && now - (lastFetchBySession.get(sessionID) ?? 0) < SUBAGENT_REFRESH_MS) return
    subagentFetchInFlight = true
    lastFetchBySession.set(sessionID, now)
    try {
      const bridge = api as unknown as SessionApi
      const totals = await fetchSubagentTotals(
        bridge.client,
        sessionID,
        bridge.state.path.directory,
        mcpServerNames(bridge),
      )
      subagentsBySession.set(sessionID, totals)
      // The user may have navigated away while this was in flight.
      if (currentSessionID() === sessionID) render(sessionID)
    } catch {
      // Server unreachable — keep whatever we last knew.
    } finally {
      subagentFetchInFlight = false
      const deferred = forceAfterInFlight
      forceAfterInFlight = ""
      if (deferred) void refreshSubagents(deferred, true)
    }
  }

  function recompute() {
    const sessionID = currentSessionID()
    if (!sessionID) {
      setReport(null)
      return
    }
    render(sessionID)
    void refreshSubagents(sessionID, false)
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
    // Idle means the turn (and any subagent it spawned) has finished, so this
    // is the one refresh that must not be throttled away.
    api.event.on("session.idle", () => {
      void refreshSubagents(currentSessionID(), true)
      scheduleRecompute()
    }),
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
              // The receipt is the number people quote, so pull the subagent
              // totals fresh rather than serving whatever the throttle last
              // allowed. The dialog re-renders when it lands.
              void refreshSubagents(currentSessionID(), true)
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
      {r.stats.subagents > 0 ? (
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>Includes:</text>
          <text fg={theme.text}>
            {r.stats.subagents} subagent{r.stats.subagents === 1 ? "" : "s"}
          </text>
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
