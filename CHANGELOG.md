# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **One installer, `install.sh`, interactive, for both harnesses.** It detects
  what is on the machine, shows it, asks which harness to set up, and confirms
  every step. It works from a clone _and_ from a bare `curl | bash` — the same
  script, deciding by whether it is sitting in a checkout — so opencode no
  longer needs a clone. `setup.sh` forwards to it, and the flags are unchanged.

  ```
  curl -fsSL https://raw.githubusercontent.com/oshricohenme/claude_plugin_realistic_cost/main/install.sh | bash
  ```

  Colour degrades automatically when stdout is not a terminal, when the
  terminal reports fewer than 8 colours, and under `NO_COLOR`. `PREFIX`,
  `BIN_DIR`, `CLAUDE_DIR`, `OPENCODE_DIR` and `VERSION` are all overridable.
  The CLI is symlinked into `~/.local/bin` rather than installed globally, so
  it needs no sudo — and `statusline.sh` already looks there.

- **Fixed while building it: an empty stdin was treated as consent.** With no
  answer available, `read` fails, and the old code turned that into "took the
  default" — so `./setup.sh </dev/null` performed a full install, replacing an
  existing Claude Code `statusLine` without anyone confirming. A failed read is
  now an error naming the non-interactive flags; an empty but _successful_ read
  is still a real Enter keypress and still takes the default.

- **Fixed: the plugin dependency install could hang forever.** `bun install` in
  `opencode/` spins on the `file:..` self-reference when a previous run left
  its self-link behind. The installer now clears that tree first and bounds the
  install to three minutes, falling back to npm with an explanation rather than
  hanging.

- ~~`install-opencode.sh`~~ was folded into `install.sh` before release. It
  fetched the npm package — which already ships the built engine, the TUI
  plugin and the skill — installs the plugin's dependencies, copies the skill
  and registers the plugin:

  ```
  curl -fsSL https://raw.githubusercontent.com/oshricohenme/claude_plugin_realistic_cost/main/install-opencode.sh | bash
  ```

  It writes only to `~/.local/share/realistic-cost` and `~/.config/opencode`,
  is idempotent (re-running upgrades in place), honours `PREFIX`,
  `OPENCODE_DIR` and `VERSION`, and prefers `bun` — checking `~/.bun/bin/bun`
  as well as `PATH`, since bun is often installed without being on it —
  falling back to `npm`. The clone + `setup.sh` route still works and remains
  the one to use when developing on the plugin.

### Added — cross-team overhead

- **MCP calls and subagents are now priced as other teams.** Both represent
  work leaving your own team, and the model now charges for that:

  |                    | Coordination                                  | Management      | Other                                       |
  | ------------------ | --------------------------------------------- | --------------- | ------------------------------------------- |
  | per MCP call       | 1.0h sync, **and 2x the per-call email rate** | —               | **2–5h of the other department's own work** |
  | per MCP **server** | —                                             | 4h, split PM/EM | **4h of engineer meeting time**             |
  | per subagent       | 2.0h                                          | 4h, EM only     | —                                           |

  An MCP call is not a library function: it is a request that another team's
  system does real work to satisfy, and that work would have been someone's day
  job — so it is billed as **Other Dept Work (MCP)**, a varying 2–5h per call
  drawn from the same deterministic generator the web-request range uses, with
  a separate seed so the two do not replay the same sequence. It is billed at
  the session's blended engineering rate, since the model has no idea what that
  department actually charges.

  Engineer meeting time is billed as engineering **overhead**, never
  implementation: it produces nothing, and folding it into implementation hours
  would have quietly inflated every PM, EM, QA, security and tech-writer
  multiplier that scales off implementation.

  Management is charged per _department_, not per request: fifty calls to one
  MCP server cost the same alignment as one, because the expensive part is
  bringing that team in at all. Subagent management goes to the EM alone —
  running work across N teams is N times the standups and the integration risk.
  Coordination appears as **Cross-Team Sync (MCP)** and **Subagent Team
  Coordination** line items; management flows through the PM and EM roles, so
  the roles table and the receipt still agree.

  On a real transcript, 157 MCP calls across 2 servers add $66,023 of other-
  department work, $31,882 of email time, $18,539 of cross-department sync and
  $945 of engineer meeting time — of a $229,401 bill. On a 40-subagent session,
  the EM goes from 134h to 295.5h.

- **MCP detection differs by harness, deliberately.** Claude Code's
  `mcp__<server>__<tool>` is unambiguous. opencode flattens MCP tools to
  `<server>_<tool>`, which looks identical to a plugin tool like `pty_spawn`,
  so the opencode plugin passes `api.state.mcp()`'s configured server list and
  a flattened name only counts when it matches one. Given no list, such calls
  are left uncounted rather than guessed at — over-counting departments would
  inflate the bill on every plugin tool.

- MCP tagging is a _tag_, not a bucket: an MCP web search is still billed at web
  read time for work, and additionally as a cross-department call. Subagents'
  own MCP calls count toward the session's departments.

- New flags: `--mcp-coordination-hours`, `--mcp-coordination-factor`,
  `--mcp-dept-work-min-hours`, `--mcp-dept-work-max-hours`,
  `--mcp-management-hours`, `--mcp-engineering-hours`,
  `--subagent-coordination-hours`, `--subagent-management-hours`.

### Fixed

- **Documentation work was billed at zero.** The Technical Writer's hours
  showed in the roles table but had no line item in the receipt at all, and the
  receipt is what produces the grand total — so a session that wrote 300 lines
  of docs was under-billed by the writer's entire cost. `Coding` and
  `Peer Review` cover BE/FE/FS/devops/data/qa only, and nothing picked up the
  writer. Added a **Documentation** line matching the role exactly.

  Found while documenting the receipt line-by-line for the README. The
  regression test that would have caught it now exists: value + management line
  items must equal the sum of all role costs, on every domain mix.

- **The engineer's cross-department meeting hours were priced twice at
  different rates** — at the blended rate in the receipt and at the engineering
  roles' own rates in the roles table. `EstimateResult` now carries the
  per-role split so both use the role rates.

- **Stats cached by an older version no longer crash the estimator.** The
  status line caches parsed stats as JSON on disk; an entry written before the
  cross-team fields existed used to throw on `stats.mcpServers.length`. Missing
  fields now price as zero.

### Changed — BREAKING (cost model)

- **Every tool call now bills a flat hour: 0.5h of work plus 0.5h of email and
  meeting time** — a read, a grep, a bash call and an edit are all worth the
  same half hour of operating a tool.

  This is charged **in addition to** code comprehension, which is unchanged
  (0.25h per glob/grep, 0.15h per read, half billed to the engineer as the
  **Code Comprehension** line). Operating a tool and understanding what it
  returned are treated as different costs, so a single read bills 0.5h of tool
  work plus its comprehension time.

  - The work half is folded into the engineering roles' implementation hours
    and shown as **Tool Work** (replacing the old _Code Comprehension_ line).
  - The email half is a new **Emails & Follow-ups** line in the coordination
    section, billed **on top of** the flat 20% coordination tax rather than
    inside it — the tax is the standing cost of being on a team, this is the
    correspondence a specific piece of work generates. Coordination therefore
    now runs above 20% of the bill (~33% on a tool-heavy session).

- **A web request costs 0.5–1h instead of the flat 0.5h**, because reading a
  fetched page takes longer than reading a local file. `WebFetch`/`WebSearch`
  and their opencode and plugin-prefixed equivalents get their own `web`
  tool-call bucket, matched by substring so `mcp__x__webfetch` counts too.

  The variation is **deterministic, not random** — seeded from the transcript
  path. `Math.random()` here would be a defect rather than a feature: the
  status line re-renders constantly and `review` gets run repeatedly on the
  same session, so a true random draw would quote a different total every time
  for work that had not changed. Each call still draws its own read time, and
  different sessions draw differently; a given session always prices the same.

  Effect on a real 40-subagent Claude Code session: $154,571 → $481,583
  (1,345h → 4,192h), of which $76,434 is the new itemized email time.

- Added `--tool-call-work-hours`, `--tool-call-coordination-hours`,
  `--web-request-min-hours` and `--web-request-max-hours`.
  `--discovery-search-hours`, `--discovery-read-hours` and
  `--discovery-thinking-hours` are unchanged.

### Fixed

- **The opencode typecheck was checking the wrong code.** Its tsconfig mapped
  `realistic-cost/core` — a package name from before the npm rename — so the
  plugin's `pre_ai_dev_cost_receipt/core` imports resolved to the built `dist/`
  instead of `src/`. The config exists precisely to stop the plugin drifting
  from the engine, and it had been checking a stale artifact. Same story at
  runtime: `npm test` now builds first, so the opencode tests exercise current
  code rather than whatever `dist/` last held.

### Fixed

- **Subagent work is now counted, on both harnesses.** A session that delegated
  to subagents was priced as if the delegated work never happened. Measured on
  real sessions, against the same worktree:

  | Session                   | Human bill before       | after                     |           |
  | ------------------------- | ----------------------- | ------------------------- | --------- |
  | Claude Code, 40 subagents | $16,241 · 19.1 man-days | $154,571 · 168.1 man-days | **9.5×**  |
  | opencode, 21 subagents    | $42,406 · 46.2 man-days | $78,291 · 85.1 man-days   | **1.85×** |

  The Claude Code multiple is larger because its transcript is the only record
  of the work: the parse saw 186 tool calls and 12 file writes where the session
  actually made 1,374 and 136. On opencode the delegated _lines_ already
  arrived through the parent's worktree diff, so only the delegated effort —
  1,075 tool calls and 450 reasoning turns — was missing.

  - **Claude Code:** sidechain turns are no longer skipped, and subagent sidecar
    transcripts under `<transcript-without-.jsonl>/subagents/**/agent-*.jsonl`
    (the layout newer versions use, including nested workflow runs) are
    discovered and folded in. A subagent's writes never also appear on the main
    thread, so the merge is additive rather than double-counting.
  - **opencode:** subagents run as child sessions, and the walk enumerates them
    through the SDK client (`client.session.children` / `session.messages`),
    **not** through the TUI's `api.state`. `api.state` holds only what the UI
    has loaded, which for a child session is usually nothing; the client asks
    the opencode server, which reads session storage directly, so the numbers
    never depend on anyone opening a subagent in the UI. Child **diffs** are
    deliberately not walked: opencode's session diff is a worktree comparison
    that already contains what subagents wrote, so adding them would
    double-count lines.

  Both walks are bounded (depth, fan-out and file caps, cycle-proof) and degrade
  to the old numbers rather than failing when a child session or sidecar is
  unreadable.

- **opencode now flags security-sensitive work it only read.** Sensitivity
  (auth / data / infra, which triples the security role's multiplier from 0.05
  to 0.15 of every implementation hour) was derived from the session diff alone,
  so a subagent that _read_ auth code without writing it left the whole session
  billing as routine. Read paths from every session, parent and subagent, now
  feed the flags — as they always had on Claude Code. Worth $2,570 on the
  opencode session measured above.

### Added

- `TranscriptStats.subagents` — how many distinct subagents contributed. Shown
  as `Subagents: N` on the terminal receipt and in the opencode dialog, so it is
  visible whether delegated work was actually picked up.
- `listSubagentTranscripts()` and `transcriptSignature()` exported from the core
  engine.
- `opencode/plugins/subagents.ts` — the subagent walk, split out of the TUI
  plugin so it is JSX-free and unit-testable. Every failure path in it is a
  caught exception, so a wrong client call fails as a silent zero rather than a
  crash; it is now covered by tests against a stub client, and its client type
  is taken from the real SDK so a signature change breaks the build. That type
  caught exactly such a bug during development — an earlier draft called
  `session.children({ path: { id } })`, the wrong client flavour, and would have
  reported zero subagents forever.

### Changed

- The status-line parse cache is keyed on mtime + size across the transcript
  **and** its subagent sidecars. Keying on the parent alone served stale numbers
  for the whole time a subagent ran, since only the sidecar was growing.
- The opencode sidebar renders the parent's numbers immediately and folds in
  subagent totals when the async walk lands. The walk is throttled to once every
  4s while a turn is running, and forced on `session.idle` and on opening
  `/realistic-cost`, so the receipt is never a stale number.

## [0.4.0] - 2026-08-25

Distribution release. The project is now installable as a first-class Claude
Code plugin, and the npm package has been renamed.

### Added

- **Claude Code plugin marketplace.** The repository hosts its own marketplace,
  so installation no longer requires a clone:

  ```
  /plugin marketplace add oshricohenme/claude_plugin_realistic_cost
  /plugin install realistic-cost@pre-ai-dev-cost-receipt
  ```

  `.claude-plugin/plugin.json` registers the `/realistic-cost` skill and the
  `Stop` hook; `.claude-plugin/marketplace.json` is the catalog. The plugin
  writes nothing to `settings.json` and adds no permission entries.

- **Plugin-root CLI resolution.** `statusline.sh` and `print-cost.sh` now also
  resolve `${CLAUDE_PLUGIN_ROOT}/dist/bin/realistic-cost.js`, so a plugin
  install that ships a build works without a global link.
- **The Stop hook no longer fails silently.** If the CLI cannot be found it
  prints the one command that fixes it, once per session, then stays quiet.

### Changed

- **The npm package is now `pre_ai_dev_cost_receipt`** (was `realistic-cost`).
  The binary, the skill and the slash command are all still `realistic-cost` —
  only the published package name changed.

  ```bash
  npm uninstall -g realistic-cost
  npm install -g pre_ai_dev_cost_receipt
  ```

  The programmatic import path changes with it:
  `import { … } from "pre_ai_dev_cost_receipt/core"`.

### Notes

- **The status line is still not part of the plugin.** Claude Code plugins
  cannot declare a `statusLine`; use `./claude-code/install.sh` or wire it into
  `settings.json` by hand.

## [0.3.0] - 2026-08-24

Correctness and safety release. Two of these were capable of damaging a user's
configuration or silently reporting numbers that were about a third too low.

### Fixed

- **The installer destroyed existing Stop hooks.** `install.sh` and `setup.sh`
  assigned `settings.hooks.Stop = [ours]` — a plain overwrite of a shared
  array — so any Stop hook belonging to another tool was silently deleted.
  `setup.sh` took no backup at all, and `install.sh` backed up only on its
  first ever run. All settings edits now go through one implementation
  (`claude-code/configure-settings.mjs`) which appends rather than replaces,
  backs up on every run, and is covered by `test/installer.test.ts`.
- **An existing `statusLine` was clobbered with no way back.** It is now
  stashed on install and restored on uninstall. Ownership is matched on the
  exact command, so a user's own `my-statusline.sh` is no longer mistaken for
  ours by substring.
- **Installers were not re-runnable.** `cp -R src dst` nests when `dst`
  exists, so a second run produced
  `skills/realistic-cost/realistic-cost/SKILL.md`.
- **Every `Edit` and `MultiEdit` was counted as zero lines.** The parser read
  `oldString`/`newString`, but Claude Code writes `old_string`/`new_string`.
  Real edit-heavy sessions were under-priced by roughly 30%. Both spellings
  are now accepted, and the test fixtures use the real format.
- **`review` and `status` could hang forever.** `readStdin` waited for end-of-
  stream on any non-TTY stdin, including a pipe nobody ever writes to — which
  is exactly what the `/realistic-cost` skill produces when it shells out.
  There is now a first-byte timeout.
- **The opencode plugin had drifted into a different cost model** — a
  different grand-total formula (`X/0.55` vs `(X+PM+EM)/0.80`), no new-file
  multiplier, and the QA-rate bug that was fixed in the core in 0.2.0. The
  inlined copy of the engine is deleted; the plugin now imports
  `realistic-cost/core`, so the two harnesses cannot disagree. The plugin is
  also typechecked for the first time (`tsconfig.opencode.json`), which
  immediately surfaced a wrong theme type, a non-existent `event.off` call,
  and a route-narrowing bug.
- **`cost.ts` restated the whole model-defaults table**, so tuning the role
  model and the receipt could diverge. Both now resolve through
  `ESTIMATE_DEFAULTS`, pinned by a test.
- **Line items could print `0.0h` next to a real amount.** With no coding in
  the session the blended rate was zero, so thinking and coordination hours
  collapsed while their costs did not. There is now a guaranteed-positive
  billing rate, and rows below the display threshold are dropped so printed
  hours always justify printed amounts.
- **Model-flag validation messages named no flag** — `[ <-]` matched the
  leading dash, so every message began `" must be a number ≥ 0"`.
- **`MODEL_FLAG_HELP.slice(0, 13)`** silently dropped any flag appended to the
  table. Flags are now table-driven, with a test asserting every model
  parameter is reachable from the CLI.
- **`--transcript` pointing at a missing file reported $0** instead of failing.
- **`currency` in a rates file was parsed and ignored.** Amounts now format in
  the configured ISO 4217 currency. Unknown roles and invalid rates in a rates
  file are reported instead of silently dropped.
- **`defaultRates()` returned a shared mutable object** that any caller could
  poison for every later estimate.
- Temp files (`print-cost.sh` counters, the statusline parse cache) moved from
  predictable paths in a world-writable directory into a private per-user
  directory, closing a symlink-redirect hole. `print-cost.sh` honours `TMPDIR`
  and parses its JSON payload with node rather than `sed`.
- Chrome no longer runs with `--no-sandbox` except as root, where it will not
  start otherwise.
- `--out report.v2` no longer produces a PDF named `.v2`, and the HTML
  fallback can no longer overwrite the file it is falling back from.

### Added

- **Data Engineer is a real role.** It was hardcoded to zero hours. SQL,
  migrations, `schema.prisma`, dbt and ETL paths now classify as a `data`
  domain and bill to it.
- **Per-role breakdown in the terminal receipt** ("Who Would Have Done It").
  The role table existed but was reachable only via `--json`.
- **`--format md`** — `formatMarkdown` existed with no way to invoke it.
- `--thinking-cost-per-token`, exposing the model's single most influential
  constant, which was the only parameter without a flag.
- `--with-permissions` on the installers. Permission entries are no longer
  written to `~/.claude/settings.json` without being asked for.
- `setup.sh --target <claude-code|opencode|both> --yes` for non-interactive
  installs. Without a terminal, setup.sh now refuses to proceed instead of
  defaulting to "install everything, yes to everything".
- ESLint, Prettier and EditorConfig; `npm run check` runs the full gate.
- CI now covers Windows and Node 24, runs the linters, and shellchecks the
  shell scripts.
- `SECURITY.md` (including exactly what the tool reads, writes and executes),
  `CODE_OF_CONDUCT.md`, issue and PR templates, Dependabot.

### Changed

- Package metadata: `repository`, `homepage`, `bugs`, `author`; `exports` now
  lists `types` first (TypeScript requires it) and has a `default` condition;
  a `prepare` script so a git install builds itself.
- The status line and Stop hook no longer fall back to `npx --yes realistic-cost`
  — resolving a package from the registry inside a status-line refresh is both
  slow and a supply-chain risk.
- Dead code removed: `renderHtml`, an unused `tool_use_id` map, a no-op
  `process.exitCode = 0`, an unreachable `MAX_MULTIPLIER`, and roughly 380
  lines of duplicated engine plus four unused helpers in the opencode plugin.
- README rewritten with per-harness install paths, and its sample output is
  now generated from a real run rather than written by hand.
- Both `SKILL.md` files described a receipt format that no longer existed
  (line items named "Speccing & Research", "Documentation").

## [0.2.0] - 2026-08-21

### Fixed

- **EstimateOptions were silently ignored.** The public options interface
  used `*Multiplier` key names while the internal defaults used different
  short names, so every programmatic override was a no-op. Keys now match
  exactly (regression-tested).
- **QA overhead rate bug**: any file `Write` triggered the cheaper
  "tests written" QA rate (35%). Now only writing test-domain files does;
  sessions that wrote only production code are billed the full 50%.
- Removed dead options (`utilizationRate`, `prWaitDaysPerPR`, `filesPerPR`)
  that were accepted but never consumed.
- `loadRateConfig` mutated the cached default-rate table; removed entirely
  along with `config/default-rates.json` — role rates now have a single
  source of truth (`src/core/roles.ts`) plus user `--rates` overrides.
- Receipt and role model could disagree: management line items are now taken
  verbatim from the role estimate's PM/EM totals, the coordination tax is
  exactly 20% of the grand total, and role percentages are computed against
  the reported grand total.
- `humanizeManDays` hardcoded 8-hour days regardless of
  `productiveHoursPerDay`.
- Line counting off-by-one: trailing newlines no longer add a phantom line
  to Write/Edit diffs.
- Transcript auto-discovery no longer falls back to "newest matching
  project dir" when several projects match — ambiguity is an explicit
  warning instead of possibly pricing another project's session.
- CLI rejects non-numeric/negative option values with a clear error instead
  of producing `$NaN`.
- PDF/PNG export cleans up its temp directory on every path (including
  failures); Chrome receives exactly one `--headless` flag.
- opencode plugin no longer writes debug logs to `/tmp/rc-debug.log` and no
  longer smuggles AI cost through an untyped field.
- `print-cost.sh` counter is now per-session (no cross-session interference),
  validates the counter file before arithmetic, and forwards the hook JSON
  to the CLI instead of assuming inherited stdin.
- `install.sh` backs up `~/.claude/settings.json` before mutating it and is
  executable as shipped.
- The CLI version string is read from `package.json` instead of being
  hardcoded.

### Added

- Per-write complexity multipliers are now actually applied: new files
  (`Write`) ×1.5 and large single writes (>100 lines) ×1.3, capped at ×6 —
  previously the large-change multiplier used a domain-average approximation
  and the new-file multiplier was dead code.
- Model tuning flags on every command: `--review-overhead`,
  `--qa-overhead`, `--qa-with-tests`, `--design-overhead`, `--pm-overhead`,
  `--em-overhead`, `--devops-deploy`, `--security-sensitive`,
  `--security-normal`, `--techwriter-overhead`, `--discovery-*-hours`,
  `--hours-per-day`.
- Status-line transcript parse cache (mtime+size keyed, in the OS temp dir,
  `--no-cache` to bypass) — the status line no longer re-parses the whole
  JSONL on every UI refresh.
- Model-math unit test suite (estimate/cost/rates/transcript/cli): 46 tests
  covering option plumbing, multiplier math, receipt coherence, rate-merge
  safety, parsing rules, and CLI validation.

### Changed

- `engines` raised to `>=20.6` (dev tooling requires it; matches README).
- Removed the duplicated plain-text renderer; the colored
  `renderTerminal` is the single terminal receipt implementation.
- `emptyStats` is exported from the core transcript module (was duplicated
  in the CLI); `formatTerminalReport` removed in favor of
  `renderTerminal` (src/cli/render.ts).
- Rates-file read failures now warn on stderr instead of silently using
  defaults.

## [0.1.0] - 2026-08-21

### Added

- Core estimation engine: 11-role human-team model (PM, EM, Designer, Backend,
  Frontend, Full-stack, QA, DevOps, Security, Data, Tech Writer) computed from
  session metadata (line counts, tool-call counts, thinking turns) — no git
  diffing.
- `realistic-cost` CLI with `status`, `review`, and `export` (HTML always;
  PDF/PNG via headless Chrome with graceful HTML fallback).
- Claude Code integration: status line, `/realistic-cost` skill, Stop-hook
  cost printer, one-command installer.
- opencode integration: TUI sidebar with live cost + `/realistic-cost` review
  dialog.
- Configurable hourly rates via `--rates <json>`.
