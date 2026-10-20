/**
 * User-facing messages for errors. API error codes map to the shared en/ta catalogue
 * (`errorMessage()` from @kadai/shared/errors); client-side failures (offline, timeout) to
 * errors:client.*. The English server `message` is developer-facing and only used as extra
 * detail in English for codes whose generic text is vague.
 */
import { errorMessage, isErrorCode } from '@kadai/shared/errors'
import i18next from 'i18next'
import { isApiError, type ClientErrorCode } from './api'
import { getLanguage, type Language } from './i18n'
import { localizeValidationMessage } from './validation'

export interface ErrorDisplay {
  title: string
  description?: string
  /** Server request id, shown for support ("Reference: …"). */
  requestId?: string
}

const CLIENT_CODES: readonly ClientErrorCode[] = ['NETWORK_ERROR', 'TIMEOUT', 'BAD_RESPONSE']
const VAGUE_CODES = new Set(['CONFLICT', 'UNPROCESSABLE'])

function isClientCode(code: string): code is ClientErrorCode {
  return (CLIENT_CODES as readonly string[]).includes(code)
}

/** Localized title/description for any thrown value. */
export function describeError(error: unknown, lng: Language = getLanguage()): ErrorDisplay {
  if (isApiError(error)) {
    if (isClientCode(error.code)) {
      return { title: i18next.t(`errors:client.${error.code}`, { lng }) }
    }
    const display: ErrorDisplay = {
      title: isErrorCode(error.code) ? errorMessage(error.code, lng) : errorMessage('INTERNAL', lng),
    }
    if (error.code === 'VALIDATION_ERROR') {
      const first = error.validationIssues[0]
      const text = first ? localizeValidationMessage(first.message) : undefined
      if (text) display.description = text
    } else if (lng === 'en' && VAGUE_CODES.has(error.code) && error.message) {
      display.description = error.message
    }
    if (error.requestId && (error.status >= 500 || !isErrorCode(error.code))) {
      display.requestId = error.requestId
    }
    return display
  }
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
    return { title: i18next.t('errors:client.UNKNOWN', { lng }) }
  }
  return { title: i18next.t('errors:client.UNKNOWN', { lng }) }
}

/** One-line localized message (title + description). */
export function errorText(error: unknown, lng: Language = getLanguage()): string {
  const d = describeError(error, lng)
  return d.description ? `${d.title} ${d.description}` : d.title
}

/** True for errors the user cannot fix by retrying the same request. */
export function isPermanentError(error: unknown): boolean {
  return isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429
}
