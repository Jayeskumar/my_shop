/**
 * Asks before leaving an editor with unsaved changes: in-app navigation is blocked (react-router
 * useBlocker) until the user confirms; closing / reloading the tab shows the browser prompt.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router'
import { useConfirm } from '@/components/ui'

/** Returns `allowLeave()`: call it right before navigating away after a successful save. */
export function useUnsavedGuard(dirty: boolean): { allowLeave: () => void } {
  const { t } = useTranslation('common')
  const confirm = useConfirm()
  const allowed = useRef(false)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !allowed.current && currentLocation.pathname !== nextLocation.pathname,
  )

  useEffect(() => {
    if (blocker.state !== 'blocked') return
    let active = true
    void confirm({
      title: t('confirm.discard_title'),
      description: t('confirm.discard_description'),
      tone: 'danger',
    }).then((ok) => {
      if (!active) return
      if (ok) blocker.proceed()
      else blocker.reset()
    })
    return () => {
      active = false
    }
  }, [blocker, confirm, t])

  useEffect(() => {
    if (!dirty) {
      allowed.current = false
      return
    }
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const allowLeave = useCallback(() => {
    allowed.current = true
  }, [])
  return { allowLeave }
}
