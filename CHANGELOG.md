# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
