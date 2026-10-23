/**
 * QR codes for UPI intents (`upi://pay?…`) drawn as SVG from the qrcode library's module matrix:
 * synchronous, crisp at any size (screen, thermal print, A4/A5 standee) and without innerHTML.
 * Error correction 'M' keeps the symbol small enough for 58 mm receipts while tolerating a
 * smudged or slightly folded print.
 */
import { create as createQr } from 'qrcode'

export interface QrMatrix {
  /** Modules per side (without the quiet zone). */
  size: number
  /** SVG path data of the dark modules, in module units (one unit = one module). */
  path: string
}

/** Quiet zone around the symbol, in modules (the spec asks for 4; 2 is fine on screens). */
export const QR_MARGIN = 2

/** Builds the dark-module path of `text`; null when the text cannot be encoded. */
export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix | null {
  if (!text) return null
  try {
    const { modules } = createQr(text, { errorCorrectionLevel: level })
    const { size, data } = modules
    const parts: string[] = []
    for (let row = 0; row < size; row++) {
      let col = 0
      while (col < size) {
        if (!data[row * size + col]) {
          col++
          continue
        }
        // Merge horizontal runs of dark modules into one rectangle.
        let run = 1
        while (col + run < size && data[row * size + col + run]) run++
        parts.push(`M${col} ${row}h${run}v1h-${run}z`)
        col += run
      }
    }
    return { size, path: parts.join('') }
  } catch {
    return null
  }
}

/** Standalone `<svg>` markup for print documents (black on white, `px` square). */
export function qrSvgMarkup(text: string, px: number, margin = 4): string | null {
  const matrix = qrMatrix(text)
  if (!matrix) return null
  const box = matrix.size + margin * 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="${-margin} ${-margin} ${box} ${box}" shape-rendering="crispEdges" role="img">` +
    `<rect x="${-margin}" y="${-margin}" width="${box}" height="${box}" fill="#fff"/>` +
    `<path d="${matrix.path}" fill="#000"/></svg>`
  )
}
