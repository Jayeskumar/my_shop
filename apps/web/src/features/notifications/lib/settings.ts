/**
 * settings.notifications helpers of the automatic-messages form: PATCH /settings takes a strict
 * deep-partial where arrays replace, so only the changed fields are sent.
 */
import type { TenantSettings } from '@kadai/shared/settings'

export type NotificationSettings = TenantSettings['notifications']

/** The changed settings.notifications fields (arrays compared as sets of days), or null. */
export function notificationsPatch(
  before: NotificationSettings,
  after: NotificationSettings,
): Partial<NotificationSettings> | null {
  const norm = (v: unknown): string =>
    JSON.stringify(Array.isArray(v) ? [...(v as number[])].sort((a, b) => a - b) : v)
  const patch: Partial<NotificationSettings> = {}
  for (const key of Object.keys(after) as (keyof NotificationSettings)[]) {
    if (norm(before[key]) !== norm(after[key])) Object.assign(patch, { [key]: after[key] })
  }
  return Object.keys(patch).length ? patch : null
}
