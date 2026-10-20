import { afterAll, describe, expect, it } from 'vitest'
import { closeTestDb, getTestConfig, randomPhone, testDb } from '../test/helpers'
import { OTP_TTL_SECONDS, OtpService, createMemoryOtpSender } from './otp'

describe('OTP service', () => {
  const config = getTestConfig()
  afterAll(() => closeTestDb())

  function setup(start = Date.now()) {
    let now = start
    const sender = createMemoryOtpSender()
    const svc = new OtpService({ systemDb: testDb().systemDb, config, sender, now: () => new Date(now) })
    return { svc, sender, advance: (s: number) => (now += s * 1000) }
  }

  it('sends a 6-digit code, stores only its HMAC and verifies it once', async () => {
    const { svc, sender } = setup()
    const phone = randomPhone()
    const res = await svc.request({ phone, purpose: 'login', ip: '127.0.0.1' })
    expect(res).toMatchObject({ expires_in: OTP_TTL_SECONDS, resend_after: 30 })
    const code = sender.lastCode(phone, 'login')!
    expect(code).toMatch(/^\d{6}$/)
    const row = await testDb().systemDb.selectFrom('otp_codes').selectAll().where('id', '=', res.otp_id).executeTakeFirstOrThrow()
    expect(row.code_hash).not.toContain(code)
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
    await expect(svc.verify({ phone, purpose: 'login', code })).resolves.toEqual({ otp_id: res.otp_id })
    await expect(svc.verify({ phone, purpose: 'login', code })).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
  })

  it('is purpose-scoped', async () => {
    const { svc, sender } = setup()
    const phone = randomPhone()
    await svc.request({ phone, purpose: 'signup' })
    await expect(svc.verify({ phone, purpose: 'login', code: sender.lastCode(phone)! })).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
  })

  it('counts wrong attempts and locks after 5', async () => {
    const { svc, sender } = setup()
    const phone = randomPhone()
    await svc.request({ phone, purpose: 'reset_password' })
    const code = sender.lastCode(phone)!
    const wrong = code === '000000' ? '111111' : '000000'
    for (let left = 4; left >= 1; left--) {
      await expect(svc.verify({ phone, purpose: 'reset_password', code: wrong })).rejects.toMatchObject({ code: 'OTP_INVALID', details: { attempts_left: left } })
    }
    await expect(svc.verify({ phone, purpose: 'reset_password', code: wrong })).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
    // Even the right code is refused now.
    await expect(svc.verify({ phone, purpose: 'reset_password', code })).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
  })

  it('expires after 5 minutes', async () => {
    const { svc, sender, advance } = setup()
    const phone = randomPhone()
    await svc.request({ phone, purpose: 'login' })
    advance(OTP_TTL_SECONDS + 1)
    await expect(svc.verify({ phone, purpose: 'login', code: sender.lastCode(phone)! })).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
  })

  it('throttles resends (30 s) and caps 3 per 10 minutes; the latest code wins', async () => {
    const { svc, sender, advance } = setup()
    const phone = randomPhone()
    await svc.request({ phone, purpose: 'login' })
    const first = sender.lastCode(phone)!
    await expect(svc.request({ phone, purpose: 'login' })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    advance(31)
    await svc.request({ phone, purpose: 'login' })
    const second = sender.lastCode(phone)!
    advance(31)
    await svc.request({ phone, purpose: 'login' })
    const third = sender.lastCode(phone)!
    advance(31)
    await expect(svc.request({ phone, purpose: 'login' })).rejects.toMatchObject({ code: 'RATE_LIMITED', details: { retry_after_seconds: expect.any(Number) } })
    if (first !== third) await expect(svc.verify({ phone, purpose: 'login', code: first })).rejects.toMatchObject({ code: 'OTP_INVALID' })
    if (second !== third) await expect(svc.verify({ phone, purpose: 'login', code: second })).rejects.toMatchObject({ code: 'OTP_INVALID' })
    await expect(svc.verify({ phone, purpose: 'login', code: third })).resolves.toBeTruthy()
  })

  it('removes the code when delivery fails', async () => {
    const phone = randomPhone()
    const svc = new OtpService({
      systemDb: testDb().systemDb,
      config,
      sender: {
        name: 'broken',
        send: () => Promise.reject(new Error('SMS gateway down')),
      },
    })
    await expect(svc.request({ phone, purpose: 'login' })).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    const rows = await testDb().systemDb.selectFrom('otp_codes').select('id').where('phone', '=', phone).execute()
    expect(rows).toEqual([])
  })

  it('issues and verifies purpose-bound otp tokens', async () => {
    const { svc } = setup()
    const { otp_token } = await svc.issueOtpToken('+919876543210', 'signup', 'otp-1')
    await expect(svc.verifyOtpToken(otp_token, 'signup')).resolves.toEqual({ phone: '+919876543210', otp_id: 'otp-1' })
    await expect(svc.verifyOtpToken(otp_token, 'reset_password')).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
    await expect(svc.verifyOtpToken('garbage', 'signup')).rejects.toMatchObject({ code: 'OTP_EXPIRED' })
  })
})
