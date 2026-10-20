import { describe, expect, it } from 'vitest'
import { isUuid, isUuidV7, newId, uuidV7Timestamp } from '../src/ids'

describe('newId', () => {
  it('generates canonical lower-case UUID v7 values', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isUuid(id)).toBe(true)
    expect(isUuidV7(id)).toBe(true)
  })

  it('is unique and time ordered (lexicographic order == creation order)', () => {
    const ids = Array.from({ length: 2000 }, () => newId())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('embeds the creation time', () => {
    const before = Date.now()
    const id = newId()
    const after = Date.now()
    const ts = uuidV7Timestamp(id)
    expect(ts).not.toBeNull()
    expect(ts!.getTime()).toBeGreaterThanOrEqual(before)
    expect(ts!.getTime()).toBeLessThanOrEqual(after)
  })
})

describe('isUuid', () => {
  it.each([
    ['0192f1a2-3b4c-7d5e-8f60-123456789abc', true],
    ['550E8400-E29B-41D4-A716-446655440000', true], // v4 upper case
    ['00000000-0000-0000-0000-000000000000', true], // nil
    ['ffffffff-ffff-ffff-ffff-ffffffffffff', true], // max
    ['550e8400-e29b-01d4-a716-446655440000', false], // version 0
    ['550e8400-e29b-41d4-c716-446655440000', false], // bad variant
    ['550e8400e29b41d4a716446655440000', false], // no dashes
    ['{550e8400-e29b-41d4-a716-446655440000}', false],
    ['', false],
    [42, false],
    [null, false],
  ])('isUuid(%j) = %s', (value, expected) => {
    expect(isUuid(value)).toBe(expected)
  })

  it('uuidV7Timestamp returns null for non-v7 ids', () => {
    expect(uuidV7Timestamp('550e8400-e29b-41d4-a716-446655440000')).toBeNull()
  })
})
