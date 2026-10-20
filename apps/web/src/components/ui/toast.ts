/**
 * Toast helpers (sonner). `notify.error(err)` turns any thrown value into a localized message
 * (ApiError code → shared en/ta catalogue; offline/timeout → errors:client.*) and de-duplicates
 * by error code so an outage does not stack twenty identical toasts.
 *
 *   notify.success(t('common:misc.saved'))
 *   mutation.mutate(data, { onError: (e) => notify.error(e) })
 */
import i18next from 'i18next'
import type { ReactNode } from 'react'
import { toast, type ExternalToast } from 'sonner'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'

type Options = Pick<ExternalToast, 'description' | 'duration' | 'id' | 'action'>

export const notify = {
  success(message: ReactNode, options?: Options) {
    return toast.success(message, options)
  },
  info(message: ReactNode, options?: Options) {
    return toast.info(message, options)
  },
  warning(message: ReactNode, options?: Options) {
    return toast.warning(message, options)
  },
  /** Shows an error: a string as-is, anything else via {@link describeError}. */
  error(error: unknown, options?: Options) {
    if (typeof error === 'string') return toast.error(error, options)
    const display = describeError(error)
    const reference = display.requestId
      ? i18next.t('errors:reference', { id: display.requestId })
      : undefined
    const description = [display.description, reference].filter(Boolean).join(' · ') || undefined
    const code = isApiError(error) ? error.code : 'UNKNOWN'
    return toast.error(display.title, {
      id: options?.id ?? `error-${code}`,
      description: options?.description ?? description,
      duration: options?.duration ?? 6_000,
      action: options?.action,
    })
  },
  /** Loading → success / error toast for a promise. */
  promise<T>(
    promise: Promise<T>,
    messages: { loading: ReactNode; success: ReactNode | ((value: T) => ReactNode) },
  ) {
    return toast.promise(promise, {
      loading: messages.loading,
      success: messages.success,
      error: (error: unknown) => describeError(error).title,
    })
  },
  dismiss(id?: string | number) {
    toast.dismiss(id)
  },
}

/** Alias kept for readability in API code: `toastApiError(error)`. */
export const toastApiError = (error: unknown): void => {
  notify.error(error)
}
