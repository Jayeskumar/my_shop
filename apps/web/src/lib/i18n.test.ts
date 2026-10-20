import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError } from './api'
import { describeError } from './errors'
import { getLanguage, i18n, NAMESPACES, resources, setLanguage, translate } from './i18n'
import { storage } from './storage'
import { localizeValidationMessage, validationToken } from './validation'

function leafKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k))
}

describe('locale files', () => {
  it('has a ta and en file for every namespace, including empty module namespaces', () => {
    expect(NAMESPACES).toEqual(
      expect.arrayContaining([
        'common',
        'auth',
        'nav',
        'errors',
        'pos',
        'sales',
        'catalog',
        'inventory',
        'purchases',
        'parties',
        'payments',
        'accounting',
        'reports',
        'notifications',
        'settings',
        'platform',
        'billing',
        'system',
        'dashboard',
      ]),
    )
    expect(Object.keys(resources.ta).sort()).toEqual(Object.keys(resources.en).sort())
  })

  it.each(Object.keys(resources.en))(
    'namespace %s has the same keys in Tamil and English',
    (ns) => {
      const en = leafKeys(resources.en[ns]).filter(Boolean).sort()
      const ta = leafKeys(resources.ta[ns]).filter(Boolean).sort()
      expect(ta).toEqual(en)
    },
  )

  it('has no empty Tamil strings', () => {
    for (const ns of Object.keys(resources.ta)) {
      const walk = (v: unknown, path: string): void => {
        if (typeof v === 'string') expect(v.trim(), `${ns}:${path}`).not.toBe('')
        else if (v && typeof v === 'object')
          for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`)
      }
      walk(resources.ta[ns], '')
    }
  })
})

describe('language switching', () => {
  it('switches translations, <html lang> and remembers the choice', async () => {
    await setLanguage('ta')
    expect(getLanguage()).toBe('ta')
    expect(document.documentElement.lang).toBe('ta')
    expect(i18n.t('actions.save')).toBe('சேமி')
    expect(translate('nav:items.pos')).toBe('புதிய பில் (POS)')
    expect(storage.get('lang', null)).toBe('ta')

    await setLanguage('en')
    expect(i18n.t('actions.save')).toBe('Save')
    expect(document.documentElement.lang).toBe('en')
  })

  it('falls back to English for a key missing in Tamil', async () => {
    i18n.addResource('en', 'common', 'test_only_key', 'English only')
    await setLanguage('ta', { persist: false })
    expect(i18n.t('test_only_key' as 'actions.save')).toBe('English only')
  })
})

describe('validation messages', () => {
  it('renders zod issues in the current language at display time', async () => {
    const schema = z.object({ name: z.string().min(1), code: z.string().min(4) })
    const result = schema.safeParse({ name: '', code: 'ab' })
    expect(result.success).toBe(false)
    const [nameIssue, codeIssue] = result.error!.issues
    expect(localizeValidationMessage(nameIssue!.message)).toBe('This field is required')
    expect(localizeValidationMessage(codeIssue!.message)).toBe('Enter at least 4 characters')
    await setLanguage('ta', { persist: false })
    expect(localizeValidationMessage(nameIssue!.message)).toBe('இந்தப் புலம் கட்டாயம்')
    expect(localizeValidationMessage(codeIssue!.message)).toBe('குறைந்தது 4 எழுத்துகள் உள்ளிடவும்')
  })

  it('maps fixed English messages of the shared schemas and API error codes', async () => {
    expect(localizeValidationMessage('Enter a valid 10-digit Indian mobile number')).toBe(
      'Enter a valid 10-digit mobile number',
    )
    expect(localizeValidationMessage('PIN_LOCKED')).toMatch(/PIN locked/)
    expect(localizeValidationMessage(validationToken('password_mismatch'))).toBe(
      'Passwords do not match',
    )
    expect(localizeValidationMessage('Some custom text')).toBe('Some custom text')
    await setLanguage('ta', { persist: false })
    expect(localizeValidationMessage('Invalid GSTIN')).toMatch(/GSTIN சரியானது அல்ல/)
  })
})

describe('describeError', () => {
  it('uses the shared en/ta catalogue for API codes and client texts for network failures', async () => {
    const invalid = new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: 'x' })
    expect(describeError(invalid).title).toBe('Wrong mobile number / email or password.')
    expect(describeError(invalid, 'ta').title).toBe(
      'மொபைல் எண் / மின்னஞ்சல் அல்லது கடவுச்சொல் தவறு.',
    )
    const offline = new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'x' })
    expect(describeError(offline).title).toMatch(/Could not reach the server/)
    const internal = new ApiError({
      status: 500,
      code: 'INTERNAL',
      message: 'x',
      requestId: 'req-9',
    })
    expect(describeError(internal).requestId).toBe('req-9')
    const validation = new ApiError({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'x',
      details: {
        issues: [{ path: 'phone', message: 'Enter a valid 10-digit Indian mobile number' }],
      },
    })
    expect(describeError(validation).description).toBe('Enter a valid 10-digit mobile number')
    expect(describeError(new Error('boom')).title).toBe('Something went wrong. Please try again.')
  })
})
