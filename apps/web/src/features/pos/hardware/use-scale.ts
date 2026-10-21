/**
 * React binding of the Web Serial scale: one connection per register for the whole POS session
 * (reopened automatically on the next visit when the port was granted before).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RegisterScaleSettings } from '@kadai/shared/settings'
import { type ScaleReading, type ScaleStatus, WebSerialScale } from './scale'

export interface UseScale {
  enabled: boolean
  status: ScaleStatus
  reading: ScaleReading | null
  /** From a click: chooses / opens the port. */
  connect: () => Promise<boolean>
  disconnect: () => Promise<void>
}

export function useScale(settings: RegisterScaleSettings | null, rememberKey: string): UseScale {
  const enabled = settings?.enabled === true
  const scaleRef = useRef<WebSerialScale | null>(null)
  const [status, setStatus] = useState<ScaleStatus>('disconnected')
  const [reading, setReading] = useState<ScaleReading | null>(null)
  const settingsKey = settings ? JSON.stringify(settings) : ''

  useEffect(() => {
    if (!enabled || !settings) {
      scaleRef.current = null
      return
    }
    const scale = new WebSerialScale(settings, { rememberKey })
    scaleRef.current = scale
    setStatus(scale.status)
    const offStatus = scale.onStatus((s) => setStatus(s))
    const offReading = scale.subscribe((r) => setReading(r))
    // Reopen a port granted earlier (no chooser without a click).
    if (scale.status !== 'unsupported') void scale.connect({ prompt: false })
    return () => {
      offStatus()
      offReading()
      void scale.disconnect()
      scaleRef.current = null
    }
    // settingsKey captures the settings object by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, settingsKey, rememberKey])

  const connect = useCallback(async () => {
    const scale = scaleRef.current
    if (!scale) return false
    return scale.connect({ prompt: true })
  }, [])

  const disconnect = useCallback(async () => {
    await scaleRef.current?.disconnect()
  }, [])

  return { enabled, status: enabled ? status : 'disconnected', reading, connect, disconnect }
}
