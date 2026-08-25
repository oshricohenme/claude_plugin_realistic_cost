# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
