/**
 * opencode's subagent accounting — the JSX-free half of the session bridge.
 *
 * opencode runs every subagent as its own session, linked to its parent by
 * `parentID`. None of that work — its tool calls, its reasoning, or its AI
 * spend — appears anywhere in the parent's own messages, so a session that
 * delegates heavily bills as near-free unless the children are read too.
 *
 * The walk goes through the SDK client rather than the TUI's `api.state` on
 * purpose: `api.state` holds only what the TUI has loaded, which for a child
 * session is usually nothing. The client asks the opencode server, which reads
 * session storage directly, so the numbers never depend on anyone opening a
 * subagent in the UI.
 *
 * This module is kept free of JSX so the tabulation can be unit-tested against
 * a stub client. That matters more than usual here: every failure path is a
 * caught exception, so a wrong client call shows up as a silent zero rather
 * than a crash.
 */

import { applyPathFlags, emptyStats, isWebTool, recordMcpCall } from "pre_ai_dev_cost_receipt/core"
import type { TranscriptStats } from "pre_ai_dev_cost_receipt/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

/**
 * The opencode SDK client, taken from the real plugin API type rather than
 * hand-rolled: the TUI's `api` reaches this module through a cast, which would
 * happily hide a signature change, and a signature change here means subagent
 * work silently stops being counted. An earlier draft of this walk called
 * `session.children({ path: { id } })` — the wrong client flavour — and would
 * have reported zero subagents forever had this type not rejected it.
 */
export type OpencodeClient = TuiPluginApi["client"]

/** Guard rails for the subagent walk: bounded depth, bounded fan-out. */
export const MAX_SUBAGENT_DEPTH = 5
export const MAX_SUBAGENT_SESSIONS = 200

/** A time window, widened as messages are seen. */
export interface Window {
  first: number
  last: number
}

/**
 * What a session's subagents add to the bill.
 *
 * `stats` carries ONLY the effort signals — tool calls, reasoning, turns.
 * Deliberately no `fileWrites` or line counts: a subagent edits files in the
 * same worktree, and opencode's session diff is a worktree comparison, so the
 * parent's diff already contains every line its subagents wrote. Adding them
 * here would bill those lines twice.
 */
export interface SubagentTotals {
  sessions: number
  stats: TranscriptStats
  aiCost: number
  window: Window
}

export function emptySubagentTotals(): SubagentTotals {
  return { sessions: 0, stats: emptyStats(), aiCost: 0, window: { first: 0, last: 0 } }
}

export function widen(window: Window, time: { created?: number; completed?: number } | undefined): void {
  const created = time?.created ?? 0
  const completed = time?.completed ?? 0
  if (created && (!window.first || created < window.first)) window.first = created
  if (completed && completed > window.last) window.last = completed
}

export function spanOf(window: Window): number {
  return window.first && window.last ? window.last - window.first : 0
}

/**
 * Fold a message's parts into `stats` and return the AI spend they record.
 * Shared by the parent walk (parts from `api.state`) and the subagent walk
 * (parts inlined in the SDK's message response), so both count identically.
 */
export function recordParts(
  stats: TranscriptStats,
  parts: readonly unknown[],
  mcpServers: readonly string[] = [],
): number {
  let aiCost = 0
  for (const rawPart of parts) {
    const part = rawPart as {
      type?: string
      tool?: string
      text?: string
      cost?: number
      state?: { input?: Record<string, unknown> }
    }
    if (part.type === "tool") {
      recordOpencodeTool(stats, part.tool ?? "", mcpServers)
      // Reading a file is a sensitivity signal even when nothing is written
      // back: a subagent that only reads auth code still means a human team
      // would have put a security engineer on it. The session diff cannot see
      // that, so the read path is captured here. opencode names the key
      // `filePath` across read/edit/write.
      if ((part.tool ?? "").toLowerCase() === "read") {
        const filePath = part.state?.input?.filePath
        if (typeof filePath === "string" && filePath) stats.filesReadPaths.push(filePath)
      }
    } else if (part.type === "reasoning") {
      stats.thinkingTurns += 1
      stats.thinkingTokens += Math.ceil((part.text ?? "").length / 4)
    } else if (part.type === "step-finish") {
      aiCost += part.cost ?? 0
    }
  }
  return aiCost
}

// ═══════════════════════════════════════════════════════════════════════════
// SUBAGENTS
//
// opencode runs every subagent as its own session, linked to its parent by
// `parentID`. None of that work — its tool calls, its reasoning, or its AI
// spend — appears anywhere in the parent's own messages, so a session that
// delegates heavily bills as near-free unless the children are read too.
//
// The walk goes through the SDK client rather than `api.state` on purpose:
// `api.state` only holds what the TUI has loaded, which for a child session is
// usually nothing. The client asks the opencode server, which reads session
// storage directly, so the numbers do not depend on anyone opening a subagent
// in the UI.
// ═══════════════════════════════════════════════════════════════════════════

/** Direct child sessions of `sessionID`, or [] if the server cannot say. */
export async function listChildSessions(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
): Promise<string[]> {
  try {
    const res = await client.session.children({ sessionID, directory })
    return (res.data ?? []).map((row) => row.id).filter((id) => id.length > 0)
  } catch {
    // Older server without the endpoint, or a transient failure. Reporting no
    // children is the honest degrade — it costs subagent detail, not accuracy
    // on what is already counted.
    return []
  }
}

/** Fold one subagent session's messages into `totals`. */
export async function ingestSubagentSession(
  client: OpencodeClient,
  sessionID: string,
  directory: string,
  totals: SubagentTotals,
  mcpServers: readonly string[],
): Promise<void> {
  let rows: Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]
  try {
    rows = (await client.session.messages({ sessionID, directory })).data
  } catch {
    return
  }
  // The SDK returns messages with their parts inlined, so unlike the parent
  // walk there is no second lookup per message.
  for (const msg of rows ?? []) {
    widen(totals.window, msg.info.time)
    if (msg.info.role !== "assistant") continue
    totals.stats.assistantTurns += 1
    totals.aiCost += recordParts(totals.stats, msg.parts, mcpServers)
  }
}

/**
 * Every descendant subagent of `rootSessionID`, tabulated the same way the
 * parent session is. Breadth-first so the shallow (and usually most
 * substantial) subagents land first if the caps cut the walk short.
 */
export async function fetchSubagentTotals(
  client: OpencodeClient,
  rootSessionID: string,
  directory: string,
  mcpServers: readonly string[] = [],
): Promise<SubagentTotals> {
  const totals = emptySubagentTotals()
  const visited = new Set<string>([rootSessionID])
  let frontier = [rootSessionID]

  for (let depth = 0; depth < MAX_SUBAGENT_DEPTH && frontier.length > 0; depth++) {
    const levels = await Promise.all(frontier.map((id) => listChildSessions(client, id, directory)))
    const next: string[] = []
    for (const id of levels.flat()) {
      if (visited.has(id) || visited.size >= MAX_SUBAGENT_SESSIONS) continue
      visited.add(id)
      next.push(id)
    }
    await Promise.all(next.map((id) => ingestSubagentSession(client, id, directory, totals, mcpServers)))
    totals.sessions += next.length
    frontier = next
  }

  return totals
}

/** Add a session's subagent totals onto its own stats, in place. */
export function mergeSubagents(stats: TranscriptStats, subs: SubagentTotals, window: Window): void {
  const from = subs.stats
  for (const key of Object.keys(stats.toolCalls) as (keyof TranscriptStats["toolCalls"])[]) {
    stats.toolCalls[key] += from.toolCalls[key]
  }
  stats.thinkingTurns += from.thinkingTurns
  stats.thinkingTokens += from.thinkingTokens
  stats.assistantTurns += from.assistantTurns
  stats.subagents += subs.sessions
  // Sensitivity is a property of the whole session's work, subagents included:
  // one subagent reading auth code moves the whole bill onto the sensitive
  // security multiplier.
  stats.filesReadPaths.push(...from.filesReadPaths)
  applyPathFlags(stats, from.filesReadPaths)
  // Cross-team contact counts wherever it happened: a subagent calling an MCP
  // server engaged that department just as surely as the parent would have.
  stats.mcpCalls += from.mcpCalls
  for (const server of from.mcpServers) {
    if (!stats.mcpServers.includes(server)) stats.mcpServers.push(server)
  }
  // Subagents run inside the parent's window in practice; widening is for the
  // case where the parent's own messages do not bracket them.
  widen(window, { created: subs.window.first, completed: subs.window.last })
  stats.durationMs = spanOf(window)
}

/** opencode's tool names, mapped onto the engine's tool-call buckets. */
export function recordOpencodeTool(
  stats: TranscriptStats,
  tool: string,
  mcpServers: readonly string[] = [],
): void {
  stats.toolCalls.total += 1
  // opencode flattens MCP tools to `<server>_<tool>`, which is indistinguishable
  // from a builtin by name alone — so the configured server list decides.
  recordMcpCall(stats, tool, mcpServers)
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
      // Same web classifier the Claude Code parser uses, so a fetched page
      // costs the same reading time on either harness.
      if (isWebTool(tool)) stats.toolCalls.web += 1
      else stats.toolCalls.other += 1
      break
  }
}
