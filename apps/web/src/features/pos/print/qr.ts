/**
 * Synchronous QR → SVG (UPI QR on receipts, the payment dialog and the customer display). Uses
 * the bundled `qrcode` encoder's matrix and draws one path, so a receipt renders without async
 * canvas work and prints crisply on 203 dpi thermal heads.
 */
import { create as createQr } from 'qrcode'

export interface QrSvgOptions {
  /** Rendered width/height in CSS units (default '100%'). */
  size?: string
  /** Quiet zone in modules (default 2; the UPI apps scan fine with 2). */
  margin?: number
  /** Error correction (default 'M'). */
  level?: 'L' | 'M' | 'Q' | 'H'
  /** Accessible label. */
  title?: string
}

/** The QR modules of a text (rows × cols booleans). */
export function qrMatrix(text: string, level: QrSvgOptions['level'] = 'M'): boolean[][] {
  const qr = createQr(text, { errorCorrectionLevel: level })
  const n = qr.modules.size
  const rows: boolean[][] = []
  for (let r = 0; r < n; r++) {
    const row: boolean[] = []
    for (let c = 0; c < n; c++) row.push(qr.modules.data[r * n + c] === 1)
    rows.push(row)
  }
  return rows
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  )
}

/** SVG markup of a QR code (black on white, shape-rendering crispEdges). */
export function qrSvg(text: string, options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 2
  const matrix = qrMatrix(text, options.level ?? 'M')
  const n = matrix.length
  const dim = n + margin * 2
  let path = ''
  matrix.forEach((row, r) => {
    let c = 0
    while (c < n) {
      if (!row[c]) {
        c++
        continue
      }
      let end = c
      while (end < n && row[end]) end++
      path += `M${c + margin} ${r + margin}h${end - c}v1h-${end - c}z`
      c = end
    }
  })
  const size = options.size ?? '100%'
  const title = options.title ? `<title>${escapeXml(options.title)}</title>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img">${title}<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
