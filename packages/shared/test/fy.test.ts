import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  addPeriods,
  compareDates,
  dayOfWeek,
  dayOfWeekIn,
  daysInMonth,
  diffDays,
  formatDateDisplay,
  fpToPeriod,
  fyOf,
  fyRange,
  fyShort,
  instantRangeForDates,
  isDateStr,
  isFy,
  isPeriod,
  minutesOfDayIn,
  nextPeriod,
  parseDisplayDate,
  periodOf,
  periodRange,
  periodToFp,
  periodsOfFy,
  previousPeriod,
  quarterEndPeriod,
  startOfDayInstant,
  timezoneOffsetMinutes,
  toDateStr,
  todayIn,
} from '../src/fy'

describe('isDateStr', () => {
  it.each([
    ['2026-10-20', true], ['2024-02-29', true], ['2000-02-29', true], ['2026-12-31', true],
    ['2026-02-29', false], ['1900-02-29', false], ['2026-13-01', false], ['2026-00-10', false],
    ['2026-04-31', false], ['2026-4-1', false], ['20261020', false], ['2026-10-20T00:00', false], [20261020, false],
  ])('isDateStr(%j) = %s', (v, expected) => {
    expect(isDateStr(v)).toBe(expected)
  })
  it('daysInMonth', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2028, m))).toEqual([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
  })
})

describe('timezone conversion', () => {
  it.each([
    ['2026-10-19T18:29:59Z', '2026-10-19'],
    ['2026-10-19T18:30:00Z', '2026-10-20'], // IST midnight
    ['2027-03-31T18:30:00Z', '2027-04-01'], // new FY in India while UTC is still 31 March
  ])('toDateStr(%s, IST) = %s', (iso, expected) => {
    expect(toDateStr(new Date(iso))).toBe(expected)
  })
  it('other timezones', () => {
    expect(toDateStr(new Date('2026-10-19T18:30:00Z'), 'UTC')).toBe('2026-10-19')
    expect(toDateStr(new Date('2026-10-20T03:00:00Z'), 'America/New_York')).toBe('2026-10-19')
  })
  it('todayIn returns a valid date', () => {
    expect(isDateStr(todayIn())).toBe(true)
    expect(isDateStr(todayIn('UTC'))).toBe(true)
  })
  it('day of week / minutes in IST', () => {
    expect(dayOfWeekIn(new Date('2026-10-18T20:00:00Z'))).toBe(1)
    expect(dayOfWeekIn(new Date('2026-10-18T20:00:00Z'), 'UTC')).toBe(0)
    expect(minutesOfDayIn(new Date('2026-10-20T06:00:00Z'))).toBe(11 * 60 + 30)
  })
  it('offsets and day boundaries', () => {
    expect(timezoneOffsetMinutes(new Date('2026-10-20T06:00:00Z'))).toBe(330)
    expect(timezoneOffsetMinutes(new Date('2026-10-20T06:00:00Z'), 'UTC')).toBe(0)
    expect(startOfDayInstant('2026-10-20').toISOString()).toBe('2026-10-19T18:30:00.000Z')
    expect(startOfDayInstant('2026-10-20', 'UTC').toISOString()).toBe('2026-10-20T00:00:00.000Z')
    // DST zone: New York 2026-03-08 starts at 05:00Z (EST), 2026-03-09 at 04:00Z (EDT)
    expect(startOfDayInstant('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(startOfDayInstant('2026-03-09', 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z')
    const r = instantRangeForDates('2026-10-01', '2026-10-31')
    expect(r.start.toISOString()).toBe('2026-09-30T18:30:00.000Z')
    expect(r.end.toISOString()).toBe('2026-10-31T18:30:00.000Z')
  })
  it('rejects invalid dates', () => {
    expect(() => toDateStr(new Date('nope'))).toThrow(RangeError)
    expect(() => startOfDayInstant('2026-02-30')).toThrow(RangeError)
  })
})

describe('date arithmetic', () => {
  it.each([
    ['2026-10-20', 1, '2026-10-21'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-10-20', -365, '2025-10-20'],
    ['2026-10-20', 0, '2026-10-20'],
  ])('addDays(%s, %d) = %s', (d, n, expected) => {
    expect(addDays(d, n)).toBe(expected)
  })
  it('diffDays / compareDates', () => {
    expect(diffDays('2026-10-01', '2026-10-31')).toBe(30)
    expect(diffDays('2026-10-31', '2026-10-01')).toBe(-30)
    expect(diffDays('2026-04-01', '2027-04-01')).toBe(365)
    expect(diffDays('2027-04-01', '2028-04-01')).toBe(366)
    expect(compareDates('2026-01-02', '2026-01-01')).toBeGreaterThan(0)
  })
  it.each([
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-10-20', 12, '2027-10-20'],
    ['2026-03-31', -1, '2026-02-28'],
    ['2026-01-15', -13, '2024-12-15'],
  ])('addMonths(%s, %d) = %s', (d, n, expected) => {
    expect(addMonths(d, n)).toBe(expected)
  })
  it('dayOfWeek', () => {
    expect(dayOfWeek('2026-10-20')).toBe(2)
    expect(dayOfWeek('2026-10-18')).toBe(0)
  })
  it('display format dd-MM-yyyy', () => {
    expect(formatDateDisplay('2026-10-05')).toBe('05-10-2026')
    expect(parseDisplayDate('05-10-2026')).toBe('2026-10-05')
    expect(parseDisplayDate('5/10/2026')).toBe('2026-10-05')
    expect(parseDisplayDate('29.02.2028')).toBe('2028-02-29')
    expect(parseDisplayDate('31-02-2026')).toBeNull()
    expect(parseDisplayDate('2026-10-05')).toBeNull()
  })
})

describe('financial year', () => {
  it.each([
    ['2026-04-01', 4, '2026-27'],
    ['2026-10-20', 4, '2026-27'],
    ['2027-03-31', 4, '2026-27'],
    ['2027-04-01', 4, '2027-28'],
    ['2026-03-31', 4, '2025-26'],
    ['2099-12-31', 4, '2099-00'],
    ['2026-06-15', 1, '2026-26'],
    ['2026-06-15', 7, '2025-26'],
    ['2026-07-01', 7, '2026-27'],
  ])('fyOf(%s, start %d) = %s', (d, start, expected) => {
    expect(fyOf(d, start)).toBe(expected)
  })
  it('fyShort', () => {
    expect(fyShort('2026-27')).toBe('2627')
    expect(fyShort('2099-00')).toBe('9900')
    expect(() => fyShort('2026')).toThrow(RangeError)
  })
  it('fyRange', () => {
    expect(fyRange('2026-27')).toEqual({ from: '2026-04-01', to: '2027-03-31' })
    expect(fyRange('2027-28')).toEqual({ from: '2027-04-01', to: '2028-03-31' })
    expect(fyRange('2026-26', 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(fyRange('2026-27', 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' })
    expect(() => fyRange('2026-28')).toThrow(RangeError)
  })
  it('isFy', () => {
    expect(isFy('2026-27')).toBe(true)
    expect(isFy('2026-28')).toBe(false)
    expect(isFy('2026-26', 1)).toBe(true)
    expect(isFy('26-27')).toBe(false)
  })
  it('every date of a FY maps back to it', () => {
    const { from, to } = fyRange('2027-28')
    for (let d = from; compareDates(d, to) <= 0; d = addDays(d, 1)) expect(fyOf(d)).toBe('2027-28')
  })
  it('periodsOfFy', () => {
    expect(periodsOfFy('2026-27')).toEqual([
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
    ])
  })
})

describe('periods & GST filing periods', () => {
  it('periodOf / periodRange', () => {
    expect(periodOf('2026-10-20')).toBe('2026-10')
    expect(periodRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(periodRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(periodRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(() => periodRange('2026-13')).toThrow(RangeError)
    expect(() => periodOf('2026-10')).toThrow(RangeError)
  })
  it('navigation', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01')
    expect(previousPeriod('2026-01')).toBe('2025-12')
    expect(addPeriods('2026-10', -10)).toBe('2025-12')
    expect(isPeriod('2026-10')).toBe(true)
    expect(isPeriod('2026-00')).toBe(false)
  })
  it('fp format', () => {
    expect(periodToFp('2026-10')).toBe('102026')
    expect(periodToFp('2027-03')).toBe('032027')
    expect(fpToPeriod('102026')).toBe('2026-10')
    expect(() => fpToPeriod('132026')).toThrow(RangeError)
    expect(() => fpToPeriod('2026-10')).toThrow(RangeError)
    expect(quarterEndPeriod('2026-04')).toBe('2026-06')
    expect(quarterEndPeriod('2026-12')).toBe('2026-12')
    expect(quarterEndPeriod('2027-02')).toBe('2027-03')
  })
})
