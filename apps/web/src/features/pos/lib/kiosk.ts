/**
 * Silent receipt printing (ARCHITECTURE.md §21.8). The Kadai desktop shortcut starts the counter
 * browser with `--kiosk-printing`, where `window.print()` sends the job straight to the default
 * printer and returns at once; a normal browser blocks in its print dialog until the cashier
 * closes it. The POS treats a counter as silent when the register setting `silent_print` is on,
 * when the page was opened with `?kiosk=1` (the shortcut target), or when the last prints
 * returned instantly (measured, remembered on this device).
 */
import { storage } from '@/lib/storage'

const KEY = 'pos.kiosk_print'
/** print() returning faster than this was not blocked by a dialog. */
const INSTANT_MS = 250

interface KioskState {
  /** Consecutive instant prints observed. */
  instant: number
  /** Consecutive blocking prints observed. */
  blocking: number
}

function read(): KioskState {
  return storage.get<KioskState>(
    KEY,
    { instant: 0, blocking: 0 },
    (v): v is KioskState =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as KioskState).instant === 'number' &&
      typeof (v as KioskState).blocking === 'number',
  )
}

/** Records how long one print() call blocked (called by the print helper). */
export function recordPrintDuration(ms: number): void {
  const s = read()
  storage.set(
    KEY,
    ms < INSTANT_MS
      ? { instant: Math.min(10, s.instant + 1), blocking: 0 }
      : { instant: 0, blocking: Math.min(10, s.blocking + 1) },
  )
}

export function kioskFromUrl(
  search: string = typeof location === 'undefined' ? '' : location.search,
): boolean {
  return new URLSearchParams(search).get('kiosk') === '1'
}

/** Whether receipts print without the dialog flow on this counter. */
export function isSilentPrinting(registerSilentPrint: boolean): boolean {
  if (registerSilentPrint || kioskFromUrl()) return true
  return read().instant >= 2
}
