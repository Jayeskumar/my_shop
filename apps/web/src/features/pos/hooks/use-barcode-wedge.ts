/**
 * Page-level keyboard-wedge scanner listener: while no text field has focus (cashier tapped a
 * button, focus on the cart), a scan burst + Enter is delivered to `onScan` and the keys are
 * swallowed. Inside the POS search box the box itself handles scans (see ProductSearch).
 */
import { useEffect, useRef } from 'react'
import { activeHotkeyScope, isTypingTarget } from '@/lib/hotkeys'
import { createWedgeDetector } from '../lib/barcode-wedge'

export function useBarcodeWedge(
  onScan: (code: string) => void,
  options: { enabled: boolean; scope: string },
): void {
  const onScanRef = useRef(onScan)
  useEffect(() => {
    onScanRef.current = onScan
  })

  useEffect(() => {
    if (!options.enabled) return
    const detector = createWedgeDetector()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      if (activeHotkeyScope() !== options.scope) {
        detector.reset()
        return
      }
      if (isTypingTarget(event.target)) {
        detector.reset()
        return
      }
      const result = detector.push({
        key: event.key,
        time: event.timeStamp,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      })
      if (result.kind === 'scan') {
        event.preventDefault()
        event.stopPropagation()
        onScanRef.current(result.code)
      } else if (result.kind === 'buffered' && event.key === ' ') {
        // Space would "click" a focused button mid-scan.
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [options.enabled, options.scope])
}
