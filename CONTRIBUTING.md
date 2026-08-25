# Contributing to realistic-cost

Thanks for your interest in contributing.

## Requirements

- **Node.js 20.6+** — required both to develop and to run the CLI
  (`engines.node` is `>=20.6`; the test runner uses `node --test --import tsx`).
- npm, or a compatible package manager.
- **Bun** and **opencode 1.4.3+**, only if you are touching the opencode TUI
  plugin.

## Setup

```bash
git clone https://github.com/oshricohenme/claude_plugin_realistic_cost.git
cd claude_plugin_realistic_cost
npm install
npm run build
```

## Development workflow

```bash
npm run dev        # run the CLI directly from TypeScript source
npm test           # node:test + tsx
npm run typecheck  # strict tsc over src/
npm run lint       # eslint
npm run format     # prettier --check
npm run check      # typecheck + lint + format + test — run before opening a PR
npm run build      # compile to dist/

# Only if you touched the opencode plugin (needs bun):
cd opencode && bun install && cd ..
npm run typecheck:opencode
```

To iterate on either harness integration in a live session:

```bash
./dev.sh                  # Claude Code: statusline + Stop hook + skill, launch claude
./dev.sh opencode         # opencode: register plugin + skill, launch opencode
./dev.sh -- <args>        # forward extra args to the harness
./dev.sh --clean          # unregister both targets
```

Dev mode never copies files or edits your global config. Both targets build
`dist/`, `npm link` the CLI, and point the harness at the working tree, so
edits to `claude-code/*.sh`, the SKILL.md, or the opencode `.tsx` are live on
the next launch (rebuild with `npm run build` after editing `src/`).

`./dev.sh` (Claude Code) specifically differs from `claude-code/install.sh`: instead
of writing to `~/.claude/settings.json`, it generates a throwaway settings file
in `.dev/` and passes it via `claude --settings`, and symlinks the skill into
this repo's `.claude/skills/` as a project-level skill. It also exports
`RC_DEV` so the statusline and Stop hook use this working tree's build even if
a published `realistic-cost` is installed globally. Your global Claude Code
config is left untouched.

## Architecture

There is **one engine**, in `src/core/`. It has no harness dependencies.

Everything else is a thin adapter over it:

- `src/cli/` — the `realistic-cost` command
- `claude-code/` — status line, Stop hook, slash command, installers
- `opencode/plugins/realistic-cost-tui.tsx` — reads opencode session state,
  renders the TUI, and **imports** `pre_ai_dev_cost_receipt/core`

The opencode plugin used to inline its own copy of the engine. It drifted — the
two produced different totals for the same session — so the copy was deleted.
**Do not reintroduce one.** If the plugin needs something from the engine,
export it from `src/core/index.ts`.

The plugin has its own tsconfig (`tsconfig.opencode.json`) because it resolves
JSX and its host API through bun. It is checked by `npm run typecheck:opencode`
and by the `opencode-plugin` CI job — deliberately _not_ by `npm run typecheck`,
which must stay runnable with npm alone. The plugin was previously excluded from
typechecking altogether, which is exactly how the drift went unnoticed; keep the
CI job green.

## The cost model

The spec is the header comment in `src/core/types.ts`; the implementation is
`src/core/estimate.ts` and `src/core/cost.ts`. Model parameters have a single
home: `ESTIMATE_DEFAULTS` in `estimate.ts`. `cost.ts` resolves through
`resolveEstimateOptions()` rather than restating them.

If you change the model:

1. Update the spec comment in `src/core/types.ts`.
2. Update the implementation.
3. Add the knob to `MODEL_FLAGS` in `src/cli/index.ts` if it is tunable — the
   table drives help text and option plumbing, and a test asserts every
   `EstimateOptions` key has a flag.
4. Update the model tables in `README.md`.
5. Add or update tests that pin the changed behaviour.
6. Include the before/after estimate for a fixed example transcript in the PR,
   so reviewers can see the impact.

## Testing notes

- Transcript fixtures must use **snake_case** tool inputs (`file_path`,
  `old_string`, `new_string`) — that is what Claude Code actually writes. A
  camelCase-only suite once stayed green while every `Edit` was being scored as
  zero lines. Both spellings are supported and both are tested.
- `test/installer.test.ts` runs the real `configure-settings.mjs` against a
  sandbox settings file. Anything that touches `~/.claude/settings.json` must
  keep those round-trip guarantees.

## Submitting changes

1. Fork and create a feature branch.
2. Make your change with tests.
3. Ensure `npm run check` passes.
4. Open a pull request describing what changed and why.

## Reporting bugs

Open an issue with the [bug report template](https://github.com/oshricohenme/claude_plugin_realistic_cost/issues/new?template=bug_report.yml).
For numbers that look wrong, use the
[cost-model feedback template](https://github.com/oshricohenme/claude_plugin_realistic_cost/issues/new?template=model_feedback.yml).

Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
