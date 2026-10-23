/** Small helpers for the users & roles screens. */
import type { MeStore } from '@kadai/shared/api/auth'
import type { Role } from '@kadai/shared/api/identity'
import { ROLE_PRESETS, type Permission, type SystemRoleCode } from '@kadai/shared/permissions'
import { getLanguage } from '@/lib/i18n'

/** Role name in the UI language (custom roles may have no Tamil name). */
export function roleLabel(name: string, nameTa: string | null | undefined): string {
  return getLanguage() === 'ta' && nameTa ? nameTa : name
}

/**
 * Whether the caller may hand out this role: only owners grant the owner role, and nobody gives
 * a role with permissions they do not hold themselves (the server answers 403 otherwise).
 */
export function canAssignRole(
  role: Pick<Role, 'code' | 'effective_permissions'>,
  myPermissions: ReadonlySet<Permission>,
  iAmOwner: boolean,
): { ok: true } | { ok: false; reason: 'owner_only' | 'role_exceeds_own_permissions' } {
  if (role.code === 'owner') return iAmOwner ? { ok: true } : { ok: false, reason: 'owner_only' }
  if (iAmOwner) return { ok: true }
  return role.effective_permissions.every((p) => myPermissions.has(p))
    ? { ok: true }
    : { ok: false, reason: 'role_exceeds_own_permissions' }
}

/** Store codes for a member's store access (null = all stores). */
export function storeCodes(
  storeIds: readonly string[] | null,
  stores: readonly MeStore[],
): string[] {
  if (storeIds === null) return []
  return storeIds.map((id) => stores.find((s) => s.id === id)?.code ?? '?')
}

/** wa.me link that sends the sign-in details to the member's WhatsApp. */
export function whatsappShareUrl(phoneE164: string | null, text: string): string {
  const digits = phoneE164 ? phoneE164.replace(/\D/g, '') : ''
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

/**
 * Description of a role in the UI language: built-in roles have Tamil texts in the shared
 * presets; custom roles show what the shop wrote.
 */
export function roleDescription(
  role: Pick<Role, 'code' | 'is_system' | 'description'>,
): string | null {
  const preset = role.is_system
    ? (ROLE_PRESETS as Readonly<Record<string, (typeof ROLE_PRESETS)[SystemRoleCode]>>)[role.code]
    : undefined
  if (preset) return getLanguage() === 'ta' ? preset.description_ta : preset.description
  return role.description
}
