#!/usr/bin/env node
import { runCli } from "../cli/index.js"

runCli(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`realistic-cost: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
