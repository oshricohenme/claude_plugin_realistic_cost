#!/usr/bin/env node
/**
 * Test runner.
 *
 * Discovers `test/*.test.ts` and hands the explicit list to `node --test`.
 *
 * Why not just `node --test 'test/*.test.ts'`? Glob expansion inside the test
 * runner only landed in Node 22, and Node 20 reports
 * `Could not find '.../test/*.test.ts'`. Letting the shell expand it instead
 * breaks on Windows, which has no shell globbing. Resolving the list here
 * works on every supported Node and every platform — and, unlike the hardcoded
 * file list this replaced, a newly added test file cannot be forgotten.
 */

import { readdirSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const testDir = join(root, "test")

const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(testDir, f))

if (files.length === 0) {
  console.error("run-tests: no test/*.test.ts files found")
  process.exit(1)
}

const res = spawnSync(process.execPath, ["--test", "--import", "tsx", ...files], {
  stdio: "inherit",
  cwd: root,
})

if (res.error) {
  console.error(`run-tests: ${res.error.message}`)
  process.exit(1)
}
process.exit(res.status ?? 1)
