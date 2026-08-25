# Contributing to realistic-cost

Thanks for your interest in contributing!

## Requirements

- **Node.js 20.6+** — both to develop (the test runner uses `node --import tsx`)
  and to run the published CLI. This matches `engines.node` in `package.json`.
- npm (or a compatible package manager).

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
npm test           # run the test suite (node:test + tsx)
npm run typecheck  # strict tsc, no emit
npm run build      # compile to dist/
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

## The cost model

The estimation model is documented in `src/core/types.ts` (the header comment
is the spec) and implemented in `src/core/estimate.ts` and `src/core/cost.ts`.

If you change the model:

1. Update the spec comment in `src/core/types.ts`.
2. Update the implementation in `src/core/estimate.ts` / `src/core/cost.ts`.
3. Update the model tables in `README.md`.
4. Add or update golden-number tests that pin the changed behavior.
5. Note that `opencode/plugins/realistic-cost-tui.tsx` inlines a copy of the
   engine and must be kept in sync (see "Limitations" in the README).

## Submitting changes

1. Fork, create a feature branch.
2. Make your change with tests.
3. Ensure `npm run typecheck && npm test && npm run build` pass.
4. Open a pull request describing what changed and why.

For model changes (rates, multipliers, allocation rules), include the
before/after estimate for a fixed example transcript so reviewers can see
the impact.

## Reporting bugs

Open an issue with:

- Your OS, Node version, and how you installed (`setup.sh`, `npm i -g`, manual).
- The command you ran and the output (redact any paths you don't want public).
- If the numbers look wrong: the receipt output and, if possible, a synthetic
  transcript that reproduces it.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
