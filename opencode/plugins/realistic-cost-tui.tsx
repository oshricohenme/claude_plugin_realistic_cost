/** @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { JSX } from "solid-js"
import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

// ═══════════════════════════════════════════════════════════════════════════
// INLINED ENGINE — self-contained, no external deps
// Mirrors src/core/{transcript,estimate,cost,roles}.ts
// ═══════════════════════════════════════════════════════════════════════════

type RoleId =
  | "pm" | "em" | "designer" | "backend" | "frontend" | "fullstack"
  | "qa" | "devops" | "security" | "data" | "techwriter"

type FileDomain =
  | "backend" | "frontend" | "fullstack" | "docs"
  | "config" | "test" | "design" | "other"

interface FileWriteOp {
  path: string
  linesAdded: number
  linesRemoved: number
  domain: FileDomain
}

interface TranscriptStats {
  toolCalls: { read: number; write: number; edit: number; glob: number; grep: number; bash: number; task: number; other: number; total: number }
  thinkingTurns: number
  thinkingTokens: number
  assistantTurns: number
  fileWrites: FileWriteOp[]
  durationMs: number
  linesAdded: number
  linesRemoved: number
  touchesAuth: boolean
  touchesData: boolean
  touchesInfra: boolean
}

interface RoleEstimate {
  role: RoleId; title: string; implementationHours: number; overheadHours: number; totalHours: number
}

type ActivitySection = "management" | "value" | "coordination"

interface ActivityCost {
  activity: string
  hours: number
  cost: number
  percentage: number
  section: ActivitySection
}

interface CostReport {
  roles: { role: RoleId; title: string; hours: number; cost: number; percentage: number }[]
  activities: ActivityCost[]
  totalCost: number
  totalHours: number
  calendar: { manDays: number; humanReadable: string }
  aiCost: number
}

// ── Rates ──

const RATES: Record<RoleId, number> = {
  pm: 135, em: 155, designer: 120, backend: 115, frontend: 110,
  fullstack: 112, qa: 90, devops: 130, security: 155, data: 120, techwriter: 80,
}

// Kept deliberately identical to src/core/cost.ts. This plugin cannot import
// from src/ (opencode loads the .tsx standalone via bun), so parity is pinned
// by test/parity.test.ts instead — change both sides together.
const COORDINATION_TAX_SHARE = 0.2
const COORDINATION_BUCKETS = 4

const ROLE_TITLES: Record<RoleId, string> = {
  pm: "Product Manager", em: "Engineering Manager", designer: "Designer",
  backend: "Backend Engineer", frontend: "Frontend Engineer", fullstack: "Fullstack Engineer",
  qa: "QA Engineer", devops: "DevOps Engineer", security: "Security Engineer",
  data: "Data Engineer", techwriter: "Technical Writer",
}

const ROLE_ORDER: RoleId[] = ["pm", "em", "designer", "backend", "frontend", "fullstack", "qa", "devops", "security", "data", "techwriter"]

const ROLE_SHORT: Record<RoleId, string> = {
  pm: "PM", em: "EM", designer: "Design", backend: "Backend", frontend: "Frontend",
  fullstack: "Fullstack", qa: "QA", devops: "DevOps", security: "Security",
  data: "Data", techwriter: "Tech Writer",
}

// ── Domain classification ──

const TEST_PATH = /(\.|_|-)(test|spec)\.(t|j)sx?$|(^|\/)(test|tests|__tests__|spec|specs)\//i
const DOCS_EXT = /\.(md|mdx|rst|txt|adoc|asciidoc|tex)$/i
const DOCS_NAME = /(readme|changelog|contributing|license|licence|authors|maintainers|code_of_conduct)/i
const DESIGN_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff?|fig|sketch|psd|ai|eps|pdf|icns|heic)$/i
const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html|htm)$/i
const FULLSTACK_PATH = /(^|\/)app\/.*\/route\.(ts|js)$|(^|\/)app\/.*\/(layout|template|loading|error|not-found)\.(ts|tsx|js|jsx)$|(^|\/)(actions|loaders)\.(ts|js)$|(^|\/)(trpc|rpc)\//i
const CONFIG_PATH = /(^|\/)(package\.json|tsconfig.*|jsconfig.*|\.eslintrc.*|\.prettierrc.*|webpack\.config.*|vite\.config.*|rollup\.config.*|turbo\.json|nx\.json|pnpm-workspace.*|Cargo\.toml|Cargo\.lock|go\.mod|requirements.*|Pipfile.*|pyproject\.toml|Gemfile.*|pom\.xml|build\.gradle.*|composer\.json|\.gitignore|\.editorconfig)$/i
const CONFIG_INFER = /(^|\/)(\.github\/|\.gitlab\/|\.circleci\/|ci\/|cd\/|deploy\/|infra\/|infrastructure\/|k8s\/|kubernetes\/|helm\/|terraform\/|docker\/|scripts\/|ops\/|sre\/)/i
const CONFIG_EXT = /\.(config|rc)\.(t|j)sx?$|\.config\.(m|c)?js$|^(dockerfile|docker-compose|compose|jenkinsfile|makefile|taskfile)$/i
const CONFIG_FILE_EXT = /\.(tf|tfvars|yaml|yml|toml|ini|env)$/i
const BACKEND_EXT = /\.(ts|js|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|sc|c|cpp|cc|cxx|h|hpp|cs|swift|php|clj|cljs|ex|exs|erl|fs|hs|lua|r|jl|dart|sql)$/i

const AUTH_HINT = /(auth|login|logout|signin|signout|signup|register|session|jwt|token|password|credential|oauth|sso|saml|permission|rbac|passport|cognito|authoriz|authentic)/i
const DATA_HINT = /(migration|migrate|schema|model|entity|prisma|sequelize|typeorm|knex|db|database|dao|repository|orm|drizzle|supabase|dynamodb|redis|mongo|etl|pipeline)/i
const INFRA_HINT = /(dockerfile|compose|\.github\/workflows|terraform|\.tf|k8s|kubernetes|helm|deploy|infrastructure|infra\/|ci\/|cd\/|\.circleci|jenkinsfile|ansible|nomad|consul|vault|argocd|skaffold|kustomize|nginx|istio|serverless|cloudformation|\.eks|gke|aks)/i

function classifyDomain(p: string): FileDomain {
  if (TEST_PATH.test(p)) return "test"
  if (DESIGN_EXT.test(p)) return "design"
  if (DOCS_EXT.test(p) || DOCS_NAME.test(p.split("/").pop() ?? "")) return "docs"
  if (CONFIG_PATH.test(p) || CONFIG_INFER.test(p) || CONFIG_EXT.test(p) || CONFIG_FILE_EXT.test(p)) return "config"
  if (FULLSTACK_PATH.test(p)) return "fullstack"
  if (FRONTEND_EXT.test(p)) return "frontend"
  if (BACKEND_EXT.test(p)) return "backend"
  return "other"
}

// ── Estimate ──

const BASE_RATE: Record<FileDomain, number> = { backend: 12, frontend: 15, fullstack: 13, docs: 30, config: 8, test: 20, design: 0, other: 10 }
const DELETION_FACTOR = 0.3
const MAX_MULT = 6.0
const DESIGN_HOURS_EACH = 2
const NEW_FILE_MULT = 1.5
const LARGE_CHANGE_THRESHOLD = 100
const LARGE_CHANGE_MULT = 1.3

function estimateHours(stats: TranscriptStats): { roles: RoleEstimate[]; implementationHours: number } {
  const byDomain: Record<FileDomain, { files: number; linesAdded: number; weightedLinesAdded: number; linesRemoved: number; hours: number }> = {} as any
  for (const d of ["backend", "frontend", "fullstack", "docs", "config", "test", "design", "other"] as FileDomain[]) {
    byDomain[d] = { files: 0, linesAdded: 0, weightedLinesAdded: 0, linesRemoved: 0, hours: 0 }
  }
  // Complexity weighting is PER WRITE, matching src/core/estimate.ts. Applying
  // it to the domain average instead both missed the new-file factor and
  // smeared one large write across every small edit in the same domain.
  for (const w of stats.fileWrites) {
    const b = byDomain[w.domain]
    let mult = 1
    if (w.tool === "Write") mult *= NEW_FILE_MULT
    if (w.linesAdded > LARGE_CHANGE_THRESHOLD) mult *= LARGE_CHANGE_MULT
    if (mult > MAX_MULT) mult = MAX_MULT
    b.files += 1; b.linesAdded += w.linesAdded; b.linesRemoved += w.linesRemoved
    b.weightedLinesAdded += w.linesAdded * mult
  }

  for (const domain of Object.keys(byDomain) as FileDomain[]) {
    const b = byDomain[domain]
    if (domain === "design") { b.hours = b.files * DESIGN_HOURS_EACH; continue }
    const base = BASE_RATE[domain] ?? BASE_RATE.other
    if (base <= 0) { b.hours = 0; continue }
    b.hours = b.weightedLinesAdded / base + (b.linesRemoved / base) * DELETION_FACTOR
  }

  const totalWriteLines = stats.fileWrites.reduce((s, w) => s + w.linesAdded + w.linesRemoved, 0)
  if (totalWriteLines === 0 && stats.linesAdded > 0) {
    byDomain.other.files = Math.max(1, stats.fileWrites.length)
    byDomain.other.linesAdded = stats.linesAdded
    byDomain.other.linesRemoved = stats.linesRemoved
    byDomain.other.hours = stats.linesAdded / BASE_RATE.other + (stats.linesRemoved / BASE_RATE.other) * DELETION_FACTOR
  }

  const impl: Record<RoleId, number> = { pm: 0, em: 0, designer: 0, backend: 0, frontend: 0, fullstack: 0, qa: 0, devops: 0, security: 0, data: 0, techwriter: 0 }
  const hasBE = byDomain.backend.files > 0
  const hasFE = byDomain.frontend.files > 0
  const splitFS = hasBE && hasFE

  impl.backend = byDomain.backend.hours
  impl.frontend = byDomain.frontend.hours
  if (splitFS) { impl.backend += byDomain.fullstack.hours * 0.5; impl.frontend += byDomain.fullstack.hours * 0.5 }
  else { impl.fullstack = byDomain.fullstack.hours }
  impl.techwriter = byDomain.docs.hours
  impl.devops = byDomain.config.hours
  impl.qa = byDomain.test.hours
  impl.designer = byDomain.design.hours
  impl.backend += byDomain.other.hours

  // Engineers spend significant time reading code to understand context.
  // Split read/search time: 50% → engineer code comprehension (implementation),
  // 50% → PM/EM/Designer discovery (management overhead).
  const searchReadHours = (stats.toolCalls.glob + stats.toolCalls.grep) * 0.25 + stats.toolCalls.read * 0.15
  const thinkingHours = stats.thinkingTurns * 0.10
  const engineerReadHours = searchReadHours * 0.5
  const discoveryHours = searchReadHours * 0.5 + thinkingHours

  // Add engineer read time to the dominant engineering domain.
  if (hasBE && hasFE) { impl.backend += engineerReadHours * 0.5; impl.frontend += engineerReadHours * 0.5 }
  else if (hasBE) { impl.backend += engineerReadHours }
  else if (hasFE) { impl.frontend += engineerReadHours }
  else if (impl.fullstack > 0) { impl.fullstack += engineerReadHours }
  else { impl.backend += engineerReadHours }

  const BE = impl.backend, FE = impl.frontend, FS = impl.fullstack
  const DEVOPS_I = impl.devops, DOC = impl.techwriter
  const implHours = BE + FE + FS + DEVOPS_I + DOC + impl.qa

  // "Wrote tests" means test-domain files, not any Write at all. The old
  // `toolCalls.write > 0` clause treated every session as tested, which is the
  // bug CHANGELOG 0.2.0 records as fixed — in core only.
  const wroteTests = impl.qa > 0
  const qaMult = wroteTests ? 0.35 : 0.5
  const secMult = stats.touchesAuth || stats.touchesData || stats.touchesInfra ? 0.15 : 0.05
  const hasFEwork = FE + FS > 0

  const roles: RoleEstimate[] = []
  const push = (role: RoleId, implH: number, ohH: number) => roles.push({ role, title: ROLE_TITLES[role], implementationHours: implH, overheadHours: ohH, totalHours: implH + ohH })

  for (const id of ROLE_ORDER) {
    switch (id) {
      case "backend": push("backend", BE, BE * 0.35); break
      case "frontend": push("frontend", FE, FE * 0.35); break
      case "fullstack": push("fullstack", FS, FS * 0.35); break
      case "devops": push("devops", DEVOPS_I, DEVOPS_I * 0.35 + 0.15 * (BE + FE + FS)); break
      case "techwriter": push("techwriter", DOC, DOC * 0.35 + 0.10 * implHours); break
      case "designer": push("designer", impl.designer, hasFEwork ? 0.60 * (FE + FS) : 0); break
      case "pm": push("pm", 0, Math.max(3, 0.15 * implHours)); break
      case "em": push("em", 0, Math.max(3, 0.10 * implHours)); break
      case "qa": push("qa", impl.qa, qaMult * implHours); break
      case "security": push("security", 0, secMult * implHours); break
      case "data": push("data", 0, 0); break
    }
  }

  return { roles, implementationHours: implHours }
}

// ── Activity breakdown ──
// Re-attributes the same total cost into activity buckets (non-overlapping, sums exactly to role total).

function computeActivities(stats: TranscriptStats, est: { roles: RoleEstimate[]; implementationHours: number }): ActivityCost[] {
  const searchReadHours = (stats.toolCalls.glob + stats.toolCalls.grep) * 0.25 + stats.toolCalls.read * 0.15
  const engineerReadHours = searchReadHours * 0.5

  const reMap = new Map(est.roles.map(r => [r.role, r]))
  const implH = (id: RoleId) => reMap.get(id)?.implementationHours ?? 0
  const ohH = (id: RoleId) => reMap.get(id)?.overheadHours ?? 0

  const BE = implH("backend"), FE = implH("frontend"), FS = implH("fullstack")
  const DEVOPS_I = implH("devops"), QA_I = implH("qa")
  const DESIGN_I = implH("designer")

  const codingTotalCost = BE * RATES.backend + FE * RATES.frontend + FS * RATES.fullstack + DEVOPS_I * RATES.devops + QA_I * RATES.qa
  const codingTotalHours = BE + FE + FS + DEVOPS_I + QA_I
  const blendedRate = codingTotalHours > 0 ? codingTotalCost / codingTotalHours : 0

  let codingHours = codingTotalHours - engineerReadHours
  let codingCost = codingTotalCost - engineerReadHours * blendedRate
  if (codingHours <= 0.01 && (stats.toolCalls.write + stats.toolCalls.edit) > 0) {
    codingHours = (stats.toolCalls.write * 0.5 + stats.toolCalls.edit * 0.3)
    codingCost = codingHours * blendedRate
  }

  const thinkingCost = stats.thinkingTokens * 0.05
  const valueActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = [
    { activity: "Thinking", hours: blendedRate > 0 ? thinkingCost / blendedRate : 0, cost: thinkingCost, section: "value" },
    { activity: "Code Comprehension", hours: engineerReadHours, cost: engineerReadHours * blendedRate, section: "value" },
    { activity: "Coding", hours: codingHours, cost: codingCost, section: "value" },
    { activity: "Design", hours: DESIGN_I + 0.60 * (FE + FS), cost: (DESIGN_I + 0.60 * (FE + FS)) * RATES.designer, section: "value" },
    { activity: "Peer Review", hours: 0.35 * (BE + FE + FS + DEVOPS_I), cost: 0.35 * (BE * RATES.backend + FE * RATES.frontend + FS * RATES.fullstack + DEVOPS_I * RATES.devops), section: "value" },
    { activity: "QA & Testing", hours: ohH("qa"), cost: ohH("qa") * RATES.qa, section: "value" },
    { activity: "DevOps & Infra", hours: 0.15 * (BE + FE + FS), cost: 0.15 * (BE + FE + FS) * RATES.devops, section: "value" },
    { activity: "Security Review", hours: ohH("security"), cost: ohH("security") * RATES.security, section: "value" },
  ].filter(a => a.hours > 0.01 || a.cost > 0.01)

  // Management — taken verbatim from the role estimate's PM and EM overhead
  // hours, so the receipt and the roles table agree. This MUST match
  // src/core/cost.ts: deriving pm/em from T instead priced the same session
  // differently in the TUI than in the CLI.
  const pmHours = ohH("pm")
  const emHours = ohH("em")
  const pmCost = pmHours * RATES.pm
  const emCost = emHours * RATES.em

  const mgmtActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = [
    { activity: "Product Management", hours: pmHours, cost: pmCost, section: "management" },
    { activity: "Engineering Management", hours: emHours, cost: emCost, section: "management" },
  ]

  // Coordination tax — COORDINATION_TAX_SHARE of the grand total, split evenly.
  // T = X + pmCost + emCost + COORDINATION_TAX_SHARE * T.
  const X = valueActs.reduce((s, a) => s + a.cost, 0)
  const T = (X + pmCost + emCost) / (1 - COORDINATION_TAX_SHARE)
  const bucketCost = (COORDINATION_TAX_SHARE * T) / COORDINATION_BUCKETS
  const bucketHours = blendedRate > 0 ? bucketCost / blendedRate : 0
  const coordActs: { activity: string; hours: number; cost: number; section: ActivitySection }[] = [
    { activity: "Meeting w/ Eng Manager", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Meeting w/ PM", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Meeting w/ DevOps", hours: bucketHours, cost: bucketCost, section: "coordination" },
    { activity: "Issue Management", hours: bucketHours, cost: bucketCost, section: "coordination" },
  ].filter(a => a.hours > 0.01 || a.cost > 0.01)

  const acts = [...mgmtActs, ...valueActs, ...coordActs]
    .filter(a => a.hours > 0.01 || a.cost > 0.01)

  const total = acts.reduce((s, a) => s + a.cost, 0)
  return acts
    .map(a => ({ ...a, percentage: total > 0 ? (a.cost / total) * 100 : 0 }))
    .sort((a, b) => {
      const order: Record<ActivitySection, number> = { management: 0, value: 1, coordination: 2 }
      if (order[a.section] !== order[b.section]) return order[a.section] - order[b.section]
      return b.cost - a.cost
    })
}

// ── Cost + calendar ──

function computeCost(stats: TranscriptStats, est: { roles: RoleEstimate[]; implementationHours: number }, aiCost: number): CostReport {
  const roles: CostReport["roles"] = []
  let totalCost = 0, totalHours = 0
  const reMap = new Map(est.roles.map(r => [r.role, r]))
  for (const id of ROLE_ORDER) {
    const re = reMap.get(id)
    const hours = re?.totalHours ?? 0
    const cost = hours * RATES[id]
    roles.push({ role: id, title: ROLE_TITLES[id], hours, cost, percentage: 0 })
    totalCost += cost; totalHours += hours
  }
  for (const r of roles) r.percentage = totalCost > 0 ? (r.cost / totalCost) * 100 : 0

  const activities = computeActivities(stats, est)
  const actTotalCost = activities.reduce((s, a) => s + a.cost, 0)
  const actTotalHours = activities.reduce((s, a) => s + a.hours, 0)
  const manDays = actTotalHours / 8

  return {
    roles, activities, totalCost: actTotalCost, totalHours: actTotalHours,
    calendar: {
      manDays,
      humanReadable: humanizeManDays(manDays),
    },
    aiCost,
  }
}

function humanizeManDays(days: number): string {
  if (days < 1) {
    const h = Math.round(days * 8)
    return h <= 0 ? "less than 1 hour" : `${h} hour${h === 1 ? "" : "s"}`
  }
  if (days < 5) return `${days.toFixed(1)} man-days`
  const weeks = Math.floor(days / 5)
  const remDays = Math.round(days - weeks * 5)
  const parts: string[] = []
  if (weeks > 0) parts.push(`${weeks} week${weeks === 1 ? "" : "s"}`)
  if (remDays > 0) parts.push(`${remDays} man-day${remDays === 1 ? "" : "s"}`)
  return parts.join(", ")
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION BRIDGE — opencode state → TranscriptStats
// ═══════════════════════════════════════════════════════════════════════════

function buildStatsFromSession(api: any, sessionID: string): { stats: TranscriptStats; aiCost: number } {
  const stats: TranscriptStats = {
    toolCalls: { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, other: 0, total: 0 },
    thinkingTurns: 0, thinkingTokens: 0, assistantTurns: 0, fileWrites: [],
    durationMs: 0, linesAdded: 0, linesRemoved: 0,
    touchesAuth: false, touchesData: false, touchesInfra: false,
  }

  // 1. Diff → file writes + lines
  try {
    const diff = api.state.session.diff(sessionID) ?? []
    for (const item of diff) {
      const path = item.file ?? ""
      const domain = classifyDomain(path)
      stats.fileWrites.push({ path, linesAdded: item.additions ?? 0, linesRemoved: item.deletions ?? 0, domain })
      stats.linesAdded += item.additions ?? 0
      stats.linesRemoved += item.deletions ?? 0
      if (AUTH_HINT.test(path)) stats.touchesAuth = true
      if (DATA_HINT.test(path)) stats.touchesData = true
      if (INFRA_HINT.test(path)) stats.touchesInfra = true
    }
  } catch {}

  // 2. Messages + parts → tool calls, thinking, AI cost, duration
  let aiCost = 0
  let firstCreated = 0
  let lastCompleted = 0
  try {
    const messages = api.state.session.messages(sessionID) ?? []
    for (const msg of messages) {
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
        const parts = api.state.part(msgId) ?? []
        for (const part of parts) {
          if (part.type === "tool") {
            stats.toolCalls.total += 1
            const name = (part.tool ?? "").toLowerCase()
            switch (name) {
              case "read": stats.toolCalls.read += 1; break
              case "write": stats.toolCalls.write += 1; break
              case "edit": case "multiedit": stats.toolCalls.edit += 1; break
              case "glob": case "list": stats.toolCalls.glob += 1; break
              case "grep": case "search": stats.toolCalls.grep += 1; break
              case "bash": case "pty": stats.toolCalls.bash += 1; break
              case "task": stats.toolCalls.task += 1; break
              default: stats.toolCalls.other += 1; break
            }
          } else if (part.type === "reasoning") {
            stats.thinkingTurns += 1
            const text = part.text ?? ""
            stats.thinkingTokens += Math.ceil(text.length / 4)
          } else if (part.type === "step-finish") {
            aiCost += part.cost ?? 0
          }
        }
      } catch {}
    }
  } catch {}

  stats.durationMs = firstCreated && lastCompleted ? lastCompleted - firstCreated : 0

  return { stats, aiCost }
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN
// ═══════════════════════════════════════════════════════════════════════════

const tui: TuiPluginModule["tui"] = async (api) => {
  const [report, setReport] = createSignal<CostReport | null>(null)
  const [alive, setAlive] = createSignal(true)

  function recompute() {
    try {
      const route = api.route.current
      if (!route || route.name !== "session" || !route.params?.sessionID) {
        setReport(null)
        return
      }
      const sid = route.params.sessionID
      const { stats, aiCost } = buildStatsFromSession(api, sid)
      if (stats.fileWrites.length === 0 && stats.linesAdded === 0 && stats.toolCalls.total === 0) {
        setReport(null)
        return
      }
      const est = estimateHours(stats)
      const cost = computeCost(stats, est, aiCost)
      setReport(cost)
    } catch {
      setReport(null)
    }
  }

  // Recompute on session/message events (debounced via microtask).
  let pending = false
  const scheduleRecompute = () => {
    if (pending) return
    pending = true
    queueMicrotask(() => { pending = false; recompute() })
  }

  api.event.on("message.updated", scheduleRecompute)
  api.event.on("session.updated", scheduleRecompute)
  api.event.on("session.idle", scheduleRecompute)

  // Initial compute.
  recompute()

  // ── Sidebar footer slot ──
  api.slots.register({
    slots: {
      sidebar_footer: (_ctx, props): JSX.Element => {
        const r = report()
        const theme = api.theme.current

        if (!r || r.totalCost === 0) {
          return (
            <box flexDirection="column" paddingLeft={1} paddingRight={1} gap={0}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                Pre-AI human engineering cost
              </text>
              <text fg={theme.textMuted}>
                /realistic-cost → full receipt
              </text>
            </box>
          )
        }

        const cost = Math.round(r.totalCost)
        const md = r.calendar.manDays.toFixed(0)
        const mgmt = r.activities.filter(a => a.section === "management")
        const value = r.activities.filter(a => a.section === "value")
        const coord = r.activities.filter(a => a.section === "coordination")
        const mgmtCost = mgmt.reduce((s, a) => s + a.cost, 0)
        const valueCost = value.reduce((s, a) => s + a.cost, 0)
        const coordCost = coord.reduce((s, a) => s + a.cost, 0)
        const W = 26
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0} gap={0}>
            {/* Title */}
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              {pad("Pre-AI Human Cost", W)}
            </text>
            {sep(theme, W)}
            {/* Section subtotals */}
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>{pad("Mgmt Overhead", 16)}</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad("$" + Math.round(mgmtCost), 9, "right")}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>{pad("Value Creation", 16)}</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad("$" + Math.round(valueCost), 9, "right")}</text>
            </box>
            <box flexDirection="row" gap={1}>
              <text fg={theme.textMuted}>{pad("Coordination Tax", 16)}</text>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad("$" + Math.round(coordCost), 9, "right")}</text>
            </box>
            {sep(theme, W)}
            {/* Grand total */}
            <box flexDirection="row" gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad("GRAND TOTAL", 16)}</text>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>{pad("$" + cost, 9, "right")}</text>
            </box>
            <text fg={theme.textMuted}>{pad("", W)}</text>
            <text fg={theme.textMuted}>{md + " man-days"}</text>
            <text fg={theme.textMuted}>{pad("", W)}</text>
            <text fg={theme.textMuted}>/realistic-cost →</text>
            <text fg={theme.textMuted}>full receipt</text>
          </box>
        )
      },
    },
  })

  // ── /realistic-cost slash command → full review dialog ──
  // keymap is not yet part of the published TuiPluginModule typing.
  const keymap = (api as { keymap?: { registerLayer?: (layer: unknown) => void } }).keymap
  if (!keymap?.registerLayer) {
    // Slash command unavailable in this opencode version — sidebar still works.
  } else {
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
              api.ui.dialog.replace(() => <ReviewDialog report={r} api={api} />)
            },
          },
        ],
      })
    } catch {
      // Slash command registration failed — sidebar still works.
    }
  }
}

// ── Helpers for JSX ──

function theme_textMuted(api: any) {
  return api.theme.current.textMuted
}

function pad(str: string, len: number, align: "left" | "right" = "left"): string {
  if (str.length >= len) return str.slice(0, len)
  const spaces = " ".repeat(len - str.length)
  return align === "right" ? spaces + str : str + spaces
}

function sep(theme: any, width = 24): JSX.Element {
  return <text fg={theme.borderSubtle}>{"─".repeat(width)}</text>
}

// Merge all engineering/dev roles into "Development". Keep PM and EM separate.
// We can't tell backend/frontend/fullstack apart from session metadata, and
// the overhead roles (QA, DevOps, Security, etc.) are all part of the dev effort.
type DisplayRole = { role: string; title: string; short: string; hours: number; cost: number; percentage: number; overheadPct?: number }

function mergeDisplayRoles(roles: CostReport["roles"]): DisplayRole[] {
  const devIds = new Set(["designer", "backend", "frontend", "fullstack", "qa", "devops", "security", "data", "techwriter"])
  let devHours = 0, devCost = 0, devPct = 0
  let pmRole: CostReport["roles"][0] | null = null
  let emRole: CostReport["roles"][0] | null = null
  for (const r of roles) {
    if (r.role === "pm") pmRole = r
    else if (r.role === "em") emRole = r
    else if (devIds.has(r.role)) {
      devHours += r.hours
      devCost += r.cost
      devPct += r.percentage
    }
  }

  const out: DisplayRole[] = []
  if (devHours > 0.01 || devCost > 0) {
    out.push({ role: "development", title: "Engineering", short: "Eng", hours: devHours, cost: devCost, percentage: devPct })
  }
  if (pmRole && pmRole.hours > 0.01) {
    const ohPct = devCost > 0 ? (pmRole.cost / devCost) * 100 : 0
    out.push({ role: "pm", title: "PM (overhead)", short: "PM", hours: pmRole.hours, cost: pmRole.cost, percentage: pmRole.percentage, overheadPct: ohPct })
  }
  if (emRole && emRole.hours > 0.01) {
    const ohPct = devCost > 0 ? (emRole.cost / devCost) * 100 : 0
    out.push({ role: "em", title: "EM (overhead)", short: "EM", hours: emRole.hours, cost: emRole.cost, percentage: emRole.percentage, overheadPct: ohPct })
  }
  return out
}

// ── Full review dialog — three-section receipt ──

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US")
}

function rateStr(n: number): string {
  if (n <= 0) return "—"
  return "$" + Math.round(n) + "/h"
}

function receiptLine(theme: any, label: string, qty: string, rate: string, amount: string, opts?: { bold?: boolean; muted?: boolean; indent?: boolean }): JSX.Element {
  const fg = opts?.muted ? theme.textMuted : opts?.bold ? theme.primary : theme.text
  const attrs = opts?.bold ? TextAttributes.BOLD : undefined
  const lbl = opts?.indent ? "  " + label : label
  return (
    <box flexDirection="row" gap={1}>
      <text fg={opts?.muted ? theme.textMuted : theme.text} attributes={attrs}>{pad(lbl, 28)}</text>
      <text fg={theme.textMuted} attributes={attrs}>{pad(qty, 6, "right")}</text>
      <text fg={theme.textMuted} attributes={attrs}>{pad(rate, 8, "right")}</text>
      <text fg={fg} attributes={attrs}>{pad(amount, 9, "right")}</text>
    </box>
  )
}

function receiptSep(theme: any, width: number, ch: string): JSX.Element {
  return <text fg={theme.borderSubtle}>{ch.repeat(width)}</text>
}

function sectionSubtotalLine(theme: any, label: string, hours: number, cost: number, opts?: { bold?: boolean; muted?: boolean }): JSX.Element {
  return receiptLine(theme, label, hours.toFixed(1) + "h", "", money(cost), opts)
}

function ReviewDialog(props: { report: CostReport; api: any }): JSX.Element {
  const r = props.report
  const theme = props.api.theme.current
  const W = 54

  const mgmt = r.activities.filter(a => a.section === "management")
  const value = r.activities.filter(a => a.section === "value")
  const coord = r.activities.filter(a => a.section === "coordination")

  const mgmtHours = mgmt.reduce((s, a) => s + a.hours, 0)
  const mgmtCost = mgmt.reduce((s, a) => s + a.cost, 0)
  const valueHours = value.reduce((s, a) => s + a.hours, 0)
  const valueCost = value.reduce((s, a) => s + a.cost, 0)
  const coordHours = coord.reduce((s, a) => s + a.hours, 0)
  const coordCost = coord.reduce((s, a) => s + a.cost, 0)
  const coordPct = r.totalCost > 0 ? (coordCost / r.totalCost) * 100 : 0

  return (
    <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={0} flexDirection="column">
      {/* Receipt header */}
      {receiptSep(theme, W, "═")}
      <box flexDirection="row" justifyContent="center">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>{"  Pre-AI Human Engineering Cost  "}</text>
      </box>
      <box flexDirection="row" justifyContent="center">
        <text fg={theme.textMuted}>what a real team would charge</text>
      </box>
      {receiptSep(theme, W, "═")}
      <text> </text>

      {/* Column header */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{pad("LINE ITEM", 28)}</text>
        <text fg={theme.textMuted}>{pad("QTY", 6, "right")}</text>
        <text fg={theme.textMuted}>{pad("RATE", 8, "right")}</text>
        <text fg={theme.textMuted}>{pad("AMOUNT", 9, "right")}</text>
      </box>
      {receiptSep(theme, W, "─")}

      {/* Section 1: Management Overhead */}
      <text fg={theme.text} attributes={TextAttributes.BOLD}>{"Management Overhead"}</text>
      {receiptSep(theme, W, "─")}
      {mgmt.map((a) => {
        const rate = a.hours > 0 ? a.cost / a.hours : 0
        return receiptLine(theme, a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost))
      })}
      {receiptSep(theme, W, "─")}
      {sectionSubtotalLine(theme, "Mgmt Overhead Subtotal", mgmtHours, mgmtCost, { bold: true })}
      <text> </text>

      {/* Section 2: Value Creation */}
      <text fg={theme.text} attributes={TextAttributes.BOLD}>{"Value Creation"}</text>
      {receiptSep(theme, W, "─")}
      {value.map((a) => {
        const rate = a.hours > 0 ? a.cost / a.hours : 0
        return receiptLine(theme, a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost))
      })}
      {receiptSep(theme, W, "─")}
      {sectionSubtotalLine(theme, "Value Creation Subtotal", valueHours, valueCost, { bold: true })}
      <text> </text>

      {/* Section 3: Coordination Tax */}
      <text fg={theme.text} attributes={TextAttributes.BOLD}>{"Coordination Tax"}</text>
      <text fg={theme.textMuted}>{"meetings, emails, slack, status"}</text>
      {receiptSep(theme, W, "─")}
      {coord.map((a) => {
        const rate = a.hours > 0 ? a.cost / a.hours : 0
        return receiptLine(theme, a.activity, a.hours.toFixed(1) + "h", rateStr(rate), money(a.cost), { indent: true })
      })}
      {receiptSep(theme, W, "─")}
      {sectionSubtotalLine(theme, "Coordination Tax Total", coordHours, coordCost, { bold: true })}
      <text fg={theme.textMuted}>{"  (" + coordPct.toFixed(0) + "% of grand total is overhead)"}</text>
      <text> </text>

      {/* Grand total */}
      {receiptSep(theme, W, "═")}
      <box flexDirection="row" gap={1}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad("GRAND TOTAL", 28)}</text>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>{pad(r.totalHours.toFixed(1) + "h", 6, "right")}</text>
        <text fg={theme.textMuted}>{pad("", 8, "right")}</text>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>{pad(money(r.totalCost), 9, "right")}</text>
      </box>
      {receiptSep(theme, W, "═")}
      <text> </text>

      {/* Footer summary */}
      <box flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>Effort:</text>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>{r.calendar.manDays.toFixed(1)} man-days</text>
        <text fg={theme.textMuted}>·</text>
        <text fg={theme.text}>{r.calendar.humanReadable}</text>
      </box>
      {r.aiCost > 0 ? (
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted}>AI cost:</text>
          <text fg={theme.success}>${r.aiCost.toFixed(2)}</text>
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
