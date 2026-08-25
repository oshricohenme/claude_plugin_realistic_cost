import { writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, extname, resolve, dirname } from "node:path"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import type { CostReport } from "../core/types.js"
import { formatHtml, formatMarkdown } from "../core/report.js"

// ---------------------------------------------------------------------------
// Write HTML to a temp file, optionally convert to PDF/PNG via headless Chrome
// ---------------------------------------------------------------------------

export type ExportFormat = "html" | "md" | "pdf" | "png"

export interface ExportResult {
  outPath: string
  format: ExportFormat
  converted: boolean
  note: string
}

/** Extensions we treat as "the user already named the file". */
const KNOWN_EXT = /^\.(html?|md|pdf|png)$/i

const EXTENSION: Record<ExportFormat, string> = {
  html: ".html",
  md: ".md",
  pdf: ".pdf",
  png: ".png",
}

/**
 * Where the HTML goes when PDF/PNG conversion is unavailable. Always appends
 * rather than substituting, so an output path without a recognised extension
 * cannot end up overwritten by its own fallback.
 */
function htmlFallbackPath(outPath: string): string {
  return KNOWN_EXT.test(extname(outPath))
    ? outPath.slice(0, outPath.length - extname(outPath).length) + ".html"
    : outPath + ".html"
}

export function exportReport(
  report: CostReport,
  opts: { format?: ExportFormat; out?: string },
): ExportResult {
  const format = opts.format ?? "html"
  const html = formatHtml(report)

  // Determine output path. Only an extension we recognise counts as one —
  // `--out report.v2` should become `report.v2.pdf`, not a PDF named ".v2".
  const ext = EXTENSION[format]
  const outPath = opts.out
    ? KNOWN_EXT.test(extname(opts.out))
      ? opts.out
      : opts.out + ext
    : defaultOutPath(report, ext)

  mkdirSync(dirname(outPath), { recursive: true })

  if (format === "html") {
    writeFileSync(outPath, html, "utf8")
    return { outPath, format, converted: false, note: "HTML written." }
  }

  if (format === "md") {
    writeFileSync(outPath, formatMarkdown(report), "utf8")
    return { outPath, format, converted: false, note: "Markdown written." }
  }

  // PDF / PNG: write HTML to temp, shell out to headless Chrome. The temp
  // dir is always removed — a fresh process per export otherwise leaks one
  // directory per run.
  const tmp = mkdtempSync(join(tmpdir(), "realistic-cost-"))
  try {
    const htmlPath = join(tmp, "report.html")
    writeFileSync(htmlPath, html, "utf8")

    const chrome = findChrome()
    if (!chrome) {
      // Graceful degrade: write HTML next to the requested output and warn.
      const fallback = htmlFallbackPath(outPath)
      writeFileSync(fallback, html, "utf8")
      return {
        outPath: fallback,
        format: "html",
        converted: false,
        note: `Chrome/Chromium not found — wrote HTML instead. Install Chrome to enable ${format.toUpperCase()} export.`,
      }
    }

    const fileUrl = `file://${htmlPath}`
    const args =
      format === "pdf"
        ? [chromeHeadlessArgs(chrome), "--print-to-pdf=" + outPath, "--print-to-pdf-no-header", fileUrl]
        : [
            chromeHeadlessArgs(chrome),
            "--screenshot=" + outPath,
            "--window-size=1200,1800",
            "--force-device-scale-factor=2",
            fileUrl,
          ]

    const res = spawnSync(chrome, args.flat(), { stdio: "ignore", timeout: 60_000 })
    if (res.error || res.status !== 0 || !existsSync(outPath)) {
      // Degrade
      const fallback = htmlFallbackPath(outPath)
      writeFileSync(fallback, html, "utf8")
      return {
        outPath: fallback,
        format: "html",
        converted: false,
        note: `Chrome ${format.toUpperCase()} conversion failed — wrote HTML instead.`,
      }
    }
    return { outPath, format, converted: true, note: `${format.toUpperCase()} written via headless Chrome.` }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function defaultOutPath(report: CostReport, ext: string): string {
  const ts = report.generatedAt.replace(/[:.]/g, "-")
  return resolve(process.cwd(), `realistic-cost-${ts}${ext}`)
}

// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : process.platform === "win32"
        ? [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/brave-browser",
            "/snap/bin/chromium",
          ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Fallback: try PATH
  const cmd = process.platform === "win32" ? "where" : "which"
  for (const name of [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "msedge",
  ]) {
    const r = spawnSync(cmd, [name], { stdio: ["ignore", "pipe", "ignore"] })
    if (r.status === 0) {
      const out = (r.stdout ?? "").toString().trim().split(/\r?\n/)[0]
      if (out && existsSync(out)) return out
    }
  }
  return null
}

/**
 * Chrome refuses to start as root without --no-sandbox, which is the usual
 * situation inside a container. Everywhere else the sandbox stays ON: this
 * renders a local file we generated, so there is no reason to disable a
 * security boundary by default.
 */
function needsNoSandbox(): boolean {
  if (process.platform === "win32") return false
  return typeof process.getuid === "function" && process.getuid() === 0
}

function chromeHeadlessArgs(binary: string): string[] {
  // Chrome/Chromium 109+ support the new headless mode; Edge and Brave only
  // accept the legacy flag. Passing both to Chrome makes the second flag
  // win and silently downgrade it — so send exactly one.
  const isEdge = /edge/i.test(binary)
  const isBrave = /brave/i.test(binary)
  const headless = isEdge || isBrave ? "--headless" : "--headless=new"
  const args = [headless, "--disable-gpu", "--hide-scrollbars"]
  if (needsNoSandbox()) args.push("--no-sandbox")
  return args
}
