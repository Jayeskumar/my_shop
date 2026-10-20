/**
 * Service worker registration (vite-plugin-pwa, registerType 'autoUpdate'): the app shell is
 * precached, new versions activate automatically, and we poll for updates hourly so counters
 * left open all day still get fixes. The POS keeps its cart in IndexedDB, so the reload that
 * follows an update does not lose a bill in progress.
 */
import { registerSW } from 'virtual:pwa-register'
import i18next from 'i18next'
import { toast } from 'sonner'

const UPDATE_CHECK_MS = 60 * 60 * 1000

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return
  registerSW({
    immediate: true,
    onOfflineReady() {
      toast.success(i18next.t('common:update.offline_ready'))
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return
      setInterval(() => {
        if (navigator.onLine && document.visibilityState === 'visible') void registration.update()
      }, UPDATE_CHECK_MS)
    },
    onRegisterError(error: unknown) {
      console.error('service worker registration failed', error)
    },
  })
}
