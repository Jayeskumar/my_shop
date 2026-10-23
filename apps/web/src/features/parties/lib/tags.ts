/** Tag rules mirroring the contract's zTags (≤ 20 tags of ≤ 30 characters, lower case). */
export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 30

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, '-').toLowerCase().slice(0, MAX_TAG_LENGTH)
}
