/**
 * Browser printing through a hidden iframe (ARCHITECTURE.md §12 "Printing"): thermal 58 mm /
 * 80 mm receipts and A4 GST invoices. Tamil shaping is done by the browser, so receipts print
 * correctly on any printer that has a driver. Modules build the HTML (invoice templates); this
 * helper only handles paper size, fonts, and the print dialog life-cycle.
 */

export type PaperSize = 'thermal_58' | 'thermal_80' | 'a4' | 'a5'

export interface PrintOptions {
  paper: PaperSize
  /** Document title (used as the default PDF filename). */
  title?: string
  /** Extra CSS appended after the base page CSS. */
  css?: string
  /** Number of copies to print (the content is repeated with page breaks). */
  copies?: number
  /** Called after the print dialog closes (or the fallback timeout). */
  onAfterPrint?: () => void
}

const PAPER_CSS: Record<PaperSize, string> = {
  // Thermal printers: content width ~48 mm on 58 mm paper, ~72 mm on 80 mm paper.
  thermal_58: `@page { size: 58mm auto; margin: 0; } body { width: 48mm; margin: 0 auto; font-size: 11px; }`,
  thermal_80: `@page { size: 80mm auto; margin: 0; } body { width: 72mm; margin: 0 auto; font-size: 12px; }`,
  a4: `@page { size: A4; margin: 12mm 10mm; } body { font-size: 12px; }`,
  a5: `@page { size: A5; margin: 8mm; } body { font-size: 11px; }`,
}

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { padding: 0; color: #000; background: #fff; }
  body {
    font-family: 'Noto Sans Tamil', 'Inter Variable', system-ui, sans-serif;
    line-height: 1.35;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  table { width: 100%; border-collapse: collapse; }
  img { max-width: 100%; }
  .num, .right { text-align: right; font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .page-break { break-after: page; page-break-after: always; }
  .no-print { display: none !important; }
`

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** Same-origin stylesheets (the app's @font-face rules) so the iframe uses the bundled fonts. */
function fontStylesheetLinks(): string {
  if (typeof document === 'undefined') return ''
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .map((l) => `<link rel="stylesheet" href="${escapeHtml(l.href)}">`)
    .join('')
}

function inlineFontFaces(): string {
  if (typeof document === 'undefined') return ''
  const rules: string[] = []
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) {
        if (rule.cssText.startsWith('@font-face')) rules.push(rule.cssText)
      }
    } catch {
      // cross-origin sheet: skip
    }
  }
  return rules.join('\n')
}

/** Builds the full HTML document printed by {@link printHtml} (exported for previews/tests). */
export function buildPrintDocument(bodyHtml: string, options: PrintOptions): string {
  const copies = Math.max(1, Math.min(5, options.copies ?? 1))
  const body = Array.from({ length: copies }, (_, i) =>
    i < copies - 1 ? `<div class="page-break">${bodyHtml}</div>` : bodyHtml,
  ).join('')
  return `<!doctype html>
<html lang="ta">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title ?? 'Kadai')}</title>
${fontStylesheetLinks()}
<style>${inlineFontFaces()}
${BASE_CSS}
${PAPER_CSS[options.paper]}
${options.css ?? ''}</style>
</head>
<body>${body}</body>
</html>`
}

async function waitForAssets(doc: Document): Promise<void> {
  const images = [...doc.images].map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          img.addEventListener('load', () => resolve(), { once: true })
          img.addEventListener('error', () => resolve(), { once: true })
        }),
  )
  const fonts = doc.fonts ? doc.fonts.ready.then(() => undefined) : Promise.resolve()
  // Never block printing for more than 3 s on a slow asset.
  await Promise.race([
    Promise.all([...images, fonts]),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ])
}

/**
 * Prints `html` (the body markup) on the chosen paper. Resolves when the print dialog has been
 * shown and closed (or after a fallback timeout on browsers without `afterprint`).
 */
export async function printHtml(html: string, options: PrintOptions): Promise<void> {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  Object.assign(iframe.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '0',
    height: '0',
    border: '0',
    visibility: 'hidden',
  })
  document.body.appendChild(iframe)
  try {
    const win = iframe.contentWindow
    const doc = iframe.contentDocument
    if (!win || !doc) throw new Error('print frame unavailable')
    doc.open()
    doc.write(buildPrintDocument(html, options))
    doc.close()
    await waitForAssets(doc)
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        resolve()
      }
      win.addEventListener('afterprint', finish, { once: true })
      win.focus()
      win.print()
      // print() blocks in most browsers; afterprint may not fire on some mobile browsers.
      setTimeout(finish, 1_000)
    })
  } finally {
    options.onAfterPrint?.()
    // Delay removal so the spooler has the document (Chrome prints asynchronously).
    setTimeout(() => iframe.remove(), 2_000)
  }
}
