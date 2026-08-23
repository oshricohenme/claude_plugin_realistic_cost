import { writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, extname, resolve, dirname } from "node:path"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import type { CostReport } from "../core/types.js"
import { formatHtml } from "../core/report.js"

// ---------------------------------------------------------------------------
// Write HTML to a temp file, optionally convert to PDF/PNG via headless Chrome
// ---------------------------------------------------------------------------

export interface ExportResult {
  outPath: string
  format: "html" | "pdf" | "png"
  converted: boolean
  note: string
}

export function exportReport(
  report: CostReport,
  opts: { format?: "html" | "pdf" | "png"; out?: string },
): ExportResult {
  const format = opts.format ?? "html"
  const html = formatHtml(report)

  // Determine output path
  const ext = format === "html" ? ".html" : format === "pdf" ? ".pdf" : ".png"
  const outPath = opts.out
    ? extname(opts.out) ? opts.out : opts.out + ext
    : defaultOutPath(report, ext)

  mkdirSync(dirname(outPath), { recursive: true })

  if (format === "html") {
    writeFileSync(outPath, html, "utf8")
    return { outPath, format, converted: false, note: "HTML written." }
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
      const fallback = outPath.replace(/\.(pdf|png)$/i, ".html")
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
        : [chromeHeadlessArgs(chrome), "--screenshot=" + outPath, "--window-size=1200,1800", "--force-device-scale-factor=2", fileUrl]

    const res = spawnSync(chrome, args.flat(), { stdio: "ignore", timeout: 60_000 })
    if (res.error || res.status !== 0 || !existsSync(outPath)) {
      // Degrade
      const fallback = outPath.replace(/\.(pdf|png)$/i, ".html")
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
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "msedge"]) {
    const r = spawnSync(cmd, [name], { stdio: ["ignore", "pipe", "ignore"] })
    if (r.status === 0) {
      const out = (r.stdout ?? "").toString().trim().split(/\r?\n/)[0]
      if (out && existsSync(out)) return out
    }
  }
  return null
}

function chromeHeadlessArgs(binary: string): string[] {
  // Chrome/Chromium 109+ support the new headless mode; Edge and Brave only
  // accept the legacy flag. Passing both to Chrome makes the second flag
  // win and silently downgrade it — so send exactly one.
  const isEdge = /edge/i.test(binary)
  const isBrave = /brave/i.test(binary)
  const headless = isEdge || isBrave ? "--headless" : "--headless=new"
  return [headless, "--disable-gpu", "--no-sandbox", "--hide-scrollbars"]
}

// Helper for callers that just want HTML bytes
export function renderHtml(report: CostReport): string {
  return formatHtml(report)
}
