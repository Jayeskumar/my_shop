/**
 * Typed plural translation for keys held outside React components (warning texts, print
 * templates). `translate()` takes exact leaf keys, so plural keys (`…_one` / `…_other`) are
 * addressed by their base name here and i18next picks the form from `count`.
 */
import i18next from 'i18next'
import type { TranslationKey } from '@/lib/i18n-resources'

/** 'purchases:warnings.near_expiry' for the leaf pair 'purchases:warnings.near_expiry_one/_other'. */
export type PluralKey = TranslationKey extends infer K
  ? K extends `${infer Base}_one`
    ? Base
    : never
  : never

export function translatePlural(
  key: PluralKey,
  count: number,
  options: Record<string, unknown> = {},
): string {
  return (i18next.t as unknown as (k: string, o: Record<string, unknown>) => string)(key, {
    ...options,
    count,
  })
}
