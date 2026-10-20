import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AddressSchema,
  DateRangeQuerySchema,
  ErrorEnvelopeSchema,
  IdParamsSchema,
  PageQuerySchema,
  dataOf,
  listOf,
  sortQuery,
  zBooleanQuery,
  zBp,
  zDateStr,
  zGstRateBp,
  zGstin,
  zHsn,
  zId,
  zOptionalGstin,
  zOptionalPhone,
  zPaise,
  zPhone,
  zQtyMilli,
  zSignedPaise,
  zStateCode,
  zTimestamp,
} from '../../src/api/common'
import { newId } from '../../src/ids'

const ok = (schema: z.ZodType, v: unknown) => schema.safeParse(v).success

describe('envelopes', () => {
  it('dataOf / listOf', () => {
    const item = z.object({ id: zId })
    const id = newId()
    expect(dataOf(item).parse({ data: { id } })).toEqual({ data: { id } })
    expect(
      listOf(item).parse({ data: [{ id }], page: { limit: 50, offset: 0, total: 1 } }).page.total,
    ).toBe(1)
    expect(ok(listOf(item), { data: [{ id }] })).toBe(false)
  })
  it('PageQuerySchema coerces and bounds', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 })
    expect(PageQuerySchema.parse({ limit: '200', offset: '40' })).toEqual({
      limit: 200,
      offset: 40,
    })
    for (const bad of [
      { limit: '0' },
      { limit: '201' },
      { offset: '-1' },
      { limit: 'abc' },
      { limit: '1.5' },
    ])
      expect(ok(PageQuerySchema, bad)).toBe(false)
  })
  it('ErrorEnvelopeSchema', () => {
    expect(
      ok(ErrorEnvelopeSchema, { error: { code: 'NOT_FOUND', message: 'x', request_id: 'r1' } }),
    ).toBe(true)
    expect(ok(ErrorEnvelopeSchema, { error: { code: 'NOT_FOUND' } })).toBe(false)
  })
})

describe('numeric fields', () => {
  it.each<[z.ZodType, unknown, boolean]>([
    [zPaise, 0, true],
    [zPaise, 12345, true],
    [zPaise, -1, false],
    [zPaise, 1.5, false],
    [zPaise, Number.MAX_SAFE_INTEGER + 1, false],
    [zPaise, '100', false],
    [zSignedPaise, -500, true],
    [zQtyMilli, 1, true],
    [zQtyMilli, 0, false],
    [zBp, 10000, true],
    [zBp, 10001, false],
    [zBp, -1, false],
    [zGstRateBp, 1800, true],
    [zGstRateBp, 4000, true],
    [zGstRateBp, 1000, false],
  ])('%#: %j → %s', (schema, value, expected) => {
    expect(ok(schema, value)).toBe(expected)
  })
})

describe('dates & timestamps', () => {
  it('zDateStr', () => {
    expect(ok(zDateStr, '2028-02-29')).toBe(true)
    expect(ok(zDateStr, '2026-02-29')).toBe(false)
    expect(ok(zDateStr, '2026-10-20T00:00:00Z')).toBe(false)
  })
  it('zTimestamp accepts ISO strings with offset and Dates, always outputs a string', () => {
    expect(zTimestamp.parse('2026-10-20T10:00:00+05:30')).toBe('2026-10-20T10:00:00+05:30')
    expect(zTimestamp.parse(new Date('2026-10-20T04:30:00Z'))).toBe('2026-10-20T04:30:00.000Z')
    expect(ok(zTimestamp, '2026-10-20T10:00:00')).toBe(false) // no offset
    expect(ok(zTimestamp, new Date('invalid'))).toBe(false)
    expect(z.toJSONSchema(zTimestamp, { io: 'output', unrepresentable: 'any' })).toMatchObject({
      type: 'string',
      format: 'date-time',
    })
  })
  it('DateRangeQuerySchema', () => {
    expect(ok(DateRangeQuerySchema, { from: '2026-10-01', to: '2026-10-31' })).toBe(true)
    expect(ok(DateRangeQuerySchema, {})).toBe(true)
    expect(ok(DateRangeQuerySchema, { from: '2026-11-01', to: '2026-10-31' })).toBe(false)
  })
})

describe('identity fields', () => {
  it('zPhone normalises Indian mobiles', () => {
    expect(zPhone.parse(' 98765 43210 ')).toBe('+919876543210')
    expect(zPhone.parse('+91-98765-43210')).toBe('+919876543210')
    const res = zPhone.safeParse('12345')
    expect(res.success).toBe(false)
    expect(res.error?.issues[0]?.message).toMatch(/mobile/)
  })
  it('zOptionalPhone maps empty to null', () => {
    const s = z.object({ phone: zOptionalPhone })
    expect(s.parse({})).toEqual({ phone: null })
    expect(s.parse({ phone: '' })).toEqual({ phone: null })
    expect(s.parse({ phone: null })).toEqual({ phone: null })
    expect(s.parse({ phone: '9876543210' })).toEqual({ phone: '+919876543210' })
    expect(ok(s, { phone: '123' })).toBe(false)
  })
  it('zGstin / zOptionalGstin', () => {
    expect(zGstin.parse(' 27aapfu0939f1zv ')).toBe('27AAPFU0939F1ZV')
    expect(ok(zGstin, '27AAPFU0939F1ZW')).toBe(false)
    const s = z.object({ gstin: zOptionalGstin })
    expect(s.parse({})).toEqual({ gstin: null })
    expect(s.parse({ gstin: '  ' })).toEqual({ gstin: null })
    expect(s.parse({ gstin: '27aapfu0939f1zv' })).toEqual({ gstin: '27AAPFU0939F1ZV' })
    expect(ok(s, { gstin: 'BAD' })).toBe(false)
  })
  it('zStateCode / zHsn / zId', () => {
    expect(ok(zStateCode, '33')).toBe(true)
    expect(ok(zStateCode, '40')).toBe(false)
    expect(zHsn.parse(' 1006 ')).toBe('1006')
    expect(ok(zHsn, '10063')).toBe(false)
    expect(ok(zId, newId())).toBe(true)
    expect(ok(zId, 'not-a-uuid')).toBe(false)
    expect(ok(IdParamsSchema, { id: newId() })).toBe(true)
  })
  it('AddressSchema trims and drops empty strings', () => {
    expect(
      AddressSchema.parse({
        line1: ' 12, Gandhi Road ',
        line2: '',
        city: 'Madurai',
        state_code: '33',
        pincode: '625001',
      }),
    ).toEqual({
      line1: '12, Gandhi Road',
      line2: undefined,
      city: 'Madurai',
      district: undefined,
      state_code: '33',
      pincode: '625001',
    })
    expect(AddressSchema.parse({ pincode: '' }).pincode).toBeUndefined()
    expect(ok(AddressSchema, { pincode: '062500' })).toBe(false)
    expect(ok(AddressSchema, { state_code: '00' })).toBe(false)
    expect(ok(AddressSchema, {})).toBe(true)
  })
})

describe('query helpers', () => {
  it('zBooleanQuery', () => {
    expect(zBooleanQuery.parse('true')).toBe(true)
    expect(zBooleanQuery.parse('false')).toBe(false)
    expect(zBooleanQuery.parse('1')).toBe(true)
    expect(zBooleanQuery.parse(false)).toBe(false)
    expect(ok(zBooleanQuery, 'maybe')).toBe(false)
  })
  it('sortQuery', () => {
    const s = sortQuery(['name', 'created_at'] as const)
    expect(s.parse('-created_at')).toEqual({ field: 'created_at', direction: 'desc' })
    expect(s.parse('name')).toEqual({ field: 'name', direction: 'asc' })
    expect(ok(s, 'password_hash')).toBe(false)
    expect(ok(s, '--name')).toBe(false)
  })
})
