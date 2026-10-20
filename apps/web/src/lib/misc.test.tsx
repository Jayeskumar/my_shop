import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makeMe } from '@/test/fixtures'
import { signIn } from '@/test/render'
import { ApiError } from './api'
import { presetRange, matchPreset } from './date-presets'
import { openDisplayChannel, type DisplayMessage } from './display-channel'
import {
  amountInWords,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPhone,
  formatQty,
  formatRelative,
} from './format'
import { setLanguage } from './i18n'
import { Can } from './permissions'
import { buildPrintDocument } from './print'
import { retryDelay, shouldRetry } from './query'
import { initialsOf } from './text'

describe('date presets (IST business dates)', () => {
  const ctx = { today: '2026-10-21' } // a Wednesday
  it('computes ranges', () => {
    expect(presetRange('today', ctx)).toEqual({ from: '2026-10-21', to: '2026-10-21' })
    expect(presetRange('yesterday', ctx)).toEqual({ from: '2026-10-20', to: '2026-10-20' })
    expect(presetRange('this_week', ctx)).toEqual({ from: '2026-10-19', to: '2026-10-21' })
    expect(presetRange('this_month', ctx)).toEqual({ from: '2026-10-01', to: '2026-10-21' })
    expect(presetRange('last_month', ctx)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(presetRange('this_fy', ctx)).toEqual({ from: '2026-04-01', to: '2026-10-21' })
    expect(presetRange('last_fy', ctx)).toEqual({ from: '2025-04-01', to: '2026-03-31' })
    expect(presetRange('this_week', { today: '2026-10-25' }).from).toBe('2026-10-19') // Sunday
  })
  it('matches a range back to its preset', () => {
    expect(
      matchPreset({ from: '2026-09-01', to: '2026-09-30' }, ['today', 'last_month'], ctx),
    ).toBe('last_month')
    expect(matchPreset({ from: '2026-09-02', to: '2026-09-30' }, ['last_month'], ctx)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats money, quantities, dates in IST and phones', async () => {
    expect(formatMoney(12345650)).toBe('₹1,23,456.50')
    expect(formatQty(1500, 'KG')).toBe('1.5 kg')
    expect(formatDate('2026-10-20')).toBe('20-10-2026')
    // 20:00 UTC = 01:30 next day in IST
    expect(formatDate('2026-10-20T20:00:00.000Z')).toBe('21-10-2026')
    expect(formatDateTime('2026-10-20T04:30:00.000Z')).toBe('20-10-2026 10:00 AM')
    expect(formatPhone('+919876543210')).toBe('98765 43210')
    expect(amountInWords(11800)).toBe('Rupees One Hundred Eighteen Only')
    const now = new Date('2026-10-20T10:00:00.000Z')
    expect(formatRelative('2026-10-20T09:55:00.000Z', 'en', now)).toBe('5 minutes ago')
    await setLanguage('ta', { persist: false })
    expect(formatQty(2000, 'PCS')).toBe('2 எண்')
  })

  it('makes grapheme-aware initials (Tamil keeps vowel signs)', () => {
    expect(initialsOf('Murugan K')).toBe('MK')
    expect(initialsOf('முருகன் கண்ணன்')).toBe('முக')
    expect(initialsOf('Lakshmi')).toBe('L')
  })
})

describe('query retry policy', () => {
  it('retries only transient failures', () => {
    expect(shouldRetry(0, new ApiError({ status: 0, code: 'NETWORK_ERROR', message: '' }))).toBe(
      true,
    )
    expect(shouldRetry(0, new ApiError({ status: 503, code: 'PROVIDER_ERROR', message: '' }))).toBe(
      true,
    )
    expect(shouldRetry(3, new ApiError({ status: 503, code: 'PROVIDER_ERROR', message: '' }))).toBe(
      false,
    )
    expect(shouldRetry(0, new ApiError({ status: 404, code: 'NOT_FOUND', message: '' }))).toBe(
      false,
    )
    expect(
      shouldRetry(0, new ApiError({ status: 422, code: 'INSUFFICIENT_STOCK', message: '' })),
    ).toBe(false)
    expect(
      retryDelay(
        1,
        new ApiError({ status: 429, code: 'RATE_LIMITED', message: '', retryAfterSeconds: 5 }),
      ),
    ).toBe(5000)
  })
})

describe('customer display channel', () => {
  it('delivers typed messages between windows', async () => {
    const pos = openDisplayChannel('display-test')
    const display = openDisplayChannel('display-test')
    const received: DisplayMessage[] = []
    display.subscribe((m) => received.push(m))
    pos.send({
      type: 'upi_qr',
      upi_uri: 'upi://pay?pa=shop@okaxis',
      amount_paise: 11800,
      payee_name: 'Shop',
      expires_at: null,
    })
    pos.send({ type: 'payment_status', status: 'paid' })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[0]).toMatchObject({ type: 'upi_qr', amount_paise: 11800 })
    pos.close()
    display.close()
  })
})

describe('print document', () => {
  it('sets the paper size and repeats copies with page breaks', () => {
    const html = buildPrintDocument('<p>Bill</p>', {
      paper: 'thermal_58',
      copies: 2,
      title: 'S1A/2627/00042',
    })
    expect(html).toContain('size: 58mm auto')
    expect(html).toContain('<title>S1A/2627/00042</title>')
    expect(html.match(/<p>Bill<\/p>/g)).toHaveLength(2)
    expect(html).toContain('page-break')
  })
})

describe('<Can>', () => {
  it('renders children only when permission and feature allow', async () => {
    await signIn(makeMe({ permissions: ['sales.read'], features: ['pos'] }))
    render(
      <>
        <Can permission="sales.read">
          <span>can-read</span>
        </Can>
        <Can permission="sales.cancel" fallback={<span>no-cancel</span>}>
          <span>can-cancel</span>
        </Can>
        <Can feature="promotions" fallback={<span>upgrade</span>}>
          <span>promos</span>
        </Can>
      </>,
    )
    expect(screen.getByText('can-read')).toBeInTheDocument()
    expect(screen.getByText('no-cancel')).toBeInTheDocument()
    expect(screen.queryByText('can-cancel')).not.toBeInTheDocument()
    expect(screen.getByText('upgrade')).toBeInTheDocument()
  })
})
