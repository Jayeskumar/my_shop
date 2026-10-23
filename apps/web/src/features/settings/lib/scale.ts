/**
 * Weighing-scale barcode helpers for the POS settings: layout check (prefix + item code + value
 * + check digit = 13), a sample barcode for the current layout, and a test scan that explains
 * why a code does not read.
 */
import {
  isValidEan13,
  makeScaleBarcode,
  parseScaleBarcode,
  type ScaleBarcode,
  type ScaleBarcodeConfig,
} from '@kadai/shared/scale'

export const EAN13_LENGTH = 13

/** Prefixes whose length breaks the 13-digit layout. */
export function badPrefixes(cfg: ScaleBarcodeConfig): string[] {
  return cfg.prefixes.filter(
    (p) => p.length + cfg.item_code_length + cfg.value_length + 1 !== EAN13_LENGTH,
  )
}

/** Digits used by the layout for the first prefix (shown as "13 / 13"). */
export function layoutLength(cfg: ScaleBarcodeConfig): number {
  const prefix = cfg.prefixes[0] ?? ''
  return prefix.length + cfg.item_code_length + cfg.value_length + 1
}

/** Sample code for PLU 123 weighing 1.250 kg (or priced ₹45.50) with this layout, or null. */
export function sampleScaleBarcode(cfg: ScaleBarcodeConfig): string | null {
  const prefix = cfg.prefixes[0]
  if (!prefix || badPrefixes(cfg).length) return null
  const value =
    cfg.value_type === 'weight'
      ? Math.round(1.25 * cfg.weight_unit_divisor)
      : Math.round(45.5 * cfg.price_divisor)
  try {
    return makeScaleBarcode(prefix, '123', value, cfg)
  } catch {
    return null
  }
}

export type ScanResult =
  | { ok: true; parsed: ScaleBarcode }
  | { ok: false; reason: 'length' | 'digits' | 'check_digit' | 'disabled' | 'prefix' | 'zero' }

/** Reads a scanned / typed code with the layout being edited. */
export function testScan(code: string, cfg: ScaleBarcodeConfig): ScanResult {
  const c = code.trim()
  if (!/^\d+$/.test(c)) return { ok: false, reason: 'digits' }
  if (c.length !== EAN13_LENGTH) return { ok: false, reason: 'length' }
  if (!isValidEan13(c)) return { ok: false, reason: 'check_digit' }
  if (!cfg.enabled) return { ok: false, reason: 'disabled' }
  if (!cfg.prefixes.some((p) => c.startsWith(p))) return { ok: false, reason: 'prefix' }
  const parsed = parseScaleBarcode(c, cfg)
  return parsed ? { ok: true, parsed } : { ok: false, reason: 'zero' }
}
