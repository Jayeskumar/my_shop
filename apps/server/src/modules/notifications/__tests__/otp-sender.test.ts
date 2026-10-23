/**
 * The provider-backed OTP sender (server.ts / worker.ts wire it into createDeps as `otpSender`):
 * MSG91 with the DLT OTP template, a provider another module registered (on-prem kadai_relay),
 * the logging fallback without a live SMS provider, failures as PROVIDER_ERROR, and the auth
 * module's OTP endpoints working through it unchanged.
 */
import {
  type NotificationProvider,
  NotificationProviderError,
  createNotificationProviderRegistry,
} from '@kadai/shared/api/notifications'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../core/errors'
import { setNotificationProviders } from '../../../core/notify'
import type { OtpMessage } from '../../../core/otp'
import { buildTestApp, getTestConfig, randomPhone } from '../../../test/helpers'
import { createNotificationOtpSender } from '../otp-sender'
import { type FakeHttpServer, fakeProvider, startFakeServer } from './fixtures'

interface LogLine {
  level: 'info' | 'warn'
  obj: Record<string, unknown>
  msg: string
}

function memoryLogger() {
  const lines: LogLine[] = []
  return {
    lines,
    info: (obj: object, msg: string) =>
      lines.push({ level: 'info', obj: obj as LogLine['obj'], msg }),
    warn: (obj: object, msg: string) =>
      lines.push({ level: 'warn', obj: obj as LogLine['obj'], msg }),
  }
}

const otp = (over: Partial<OtpMessage> = {}): OtpMessage => ({
  phone: '+919876543210',
  code: '482913',
  purpose: 'login',
  locale: 'ta',
  expiresInSeconds: 300,
  ...over,
})

let server: FakeHttpServer
beforeAll(async () => {
  server = await startFakeServer()
})
afterAll(() => server.close())
beforeEach(() => {
  server.requests.length = 0
  server.respond.length = 0
  // A fresh process registry: the sender installs the providers of its own configuration.
  setNotificationProviders(createNotificationProviderRegistry())
})

const msg91Env = () => ({
  SMS_PROVIDER: 'msg91',
  MSG91_AUTH_KEY: 'otp-auth-key',
  MSG91_SENDER_ID: 'KADAIS',
  MSG91_OTP_TEMPLATE_ID: 'otp-flow-1',
  MSG91_BASE_URL: server.url,
})

describe('notifications OTP sender', () => {
  it('sends the code through MSG91 with the DLT OTP template (never logging it)', async () => {
    const log = memoryLogger()
    const sender = createNotificationOtpSender(getTestConfig(msg91Env()), log)
    expect(sender.name).toBe('notifications')
    server.respond.push({ status: 200, body: { type: 'success', message: 'req-otp-1' } })
    await sender.send(otp())
    expect(server.requests).toHaveLength(1)
    const req = server.requests[0]!
    expect(req.url).toBe('/api/v5/flow')
    expect(req.headers.authkey).toBe('otp-auth-key')
    expect(req.json).toEqual({
      template_id: 'otp-flow-1',
      short_url: '0',
      sender: 'KADAIS',
      recipients: [{ mobiles: '919876543210', otp: '482913', minutes: '5' }],
    })
    expect(JSON.stringify(log.lines)).not.toContain('482913')
  })

  it('fails the OTP request with PROVIDER_ERROR when the SMS cannot be sent', async () => {
    const log = memoryLogger()
    const sender = createNotificationOtpSender(getTestConfig(msg91Env()), log)
    server.respond.push({ status: 500, body: { type: 'error', message: 'internal' } })
    const err = await sender.send(otp()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(log.lines.find((l) => l.level === 'warn')!.obj).toMatchObject({
      provider: 'msg91',
      kind: 'retryable',
      phone: '98XXX XX210',
    })
    expect(JSON.stringify(log.lines)).not.toContain('482913')

    // Without the OTP template id nothing is sent (DLT would reject it). Configuration
    // validation requires MSG91_OTP_TEMPLATE_ID with SMS_PROVIDER=msg91, so drop it by hand.
    setNotificationProviders(createNotificationProviderRegistry())
    const base = getTestConfig(msg91Env())
    const noTemplate = createNotificationOtpSender(
      {
        ...base,
        sms: {
          ...base.sms,
          msg91: { ...base.sms.msg91, otpTemplateId: null, templateIds: {} },
        },
      },
      memoryLogger(),
    )
    const err2 = await noTemplate.send(otp()).catch((e: unknown) => e)
    expect(err2).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(server.requests).toHaveLength(1)
  })

  it('logs the code in development and only a warning in production without a live SMS provider', async () => {
    const devLog = memoryLogger()
    const config = getTestConfig({ SMS_PROVIDER: 'log' })
    await createNotificationOtpSender(config, devLog).send(otp())
    expect(devLog.lines[0]).toMatchObject({ level: 'info', obj: { otp_code: '482913' } })

    setNotificationProviders(createNotificationProviderRegistry())
    const prodLog = memoryLogger()
    await createNotificationOtpSender({ ...config, isProduction: true }, prodLog).send(otp())
    expect(prodLog.lines[0]!.level).toBe('warn')
    expect(JSON.stringify(prodLog.lines)).not.toContain('482913')
    expect(server.requests).toHaveLength(0)
  })

  it('uses an SMS provider another module registered (on-prem kadai_relay)', async () => {
    const relay = fakeProvider('kadai_relay', ['sms', 'whatsapp'])
    setNotificationProviders(createNotificationProviderRegistry([relay]))
    const sender = createNotificationOtpSender(
      getTestConfig({ SMS_PROVIDER: 'log' }),
      memoryLogger(),
    )
    await sender.send(otp({ locale: 'en', expiresInSeconds: 600 }))
    expect(relay.sent).toHaveLength(1)
    expect(relay.sent[0]).toMatchObject({
      channel: 'sms',
      template_code: 'otp',
      locale: 'en',
      to: '+919876543210',
      params: { otp: '482913', minutes: '10' },
      notification_id: null,
      tenant_id: null,
    })
    expect(relay.sent[0]!.body).toBe(
      '482913 is your Kadai verification code. It is valid for 10 minutes. Do not share it with anyone.',
    )
    expect(relay.sent[0]!.idempotency_key).toMatch(/^otp:/)

    // A relay refusal is a PROVIDER_ERROR as well.
    relay.script.push(
      new NotificationProviderError({
        message: 'quota exceeded',
        kind: 'permanent',
        provider: 'kadai_relay',
        code: 'provider_error',
      }),
    )
    await expect(sender.send(otp())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('an unconfigured provider is not "live": the code is logged instead', async () => {
    const unconfigured: NotificationProvider = {
      ...fakeProvider('kadai_relay', ['sms']),
      configured: false,
    }
    setNotificationProviders(createNotificationProviderRegistry([unconfigured]))
    const log = memoryLogger()
    await createNotificationOtpSender(getTestConfig({ SMS_PROVIDER: 'log' }), log).send(otp())
    expect(log.lines[0]!.obj).toMatchObject({ otp_code: '482913' })
  })
})

describe('auth OTP endpoints with the notifications sender', () => {
  it('delivers the signup code by SMS and the code verifies', async () => {
    const env = msg91Env()
    const t = await buildTestApp({
      env,
      depsOptions: { otpSender: createNotificationOtpSender(getTestConfig(env), memoryLogger()) },
    })
    try {
      const phone = randomPhone()
      server.respond.push({ status: 200, body: { type: 'success', message: 'req-otp-2' } })
      const req = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        headers: { 'x-locale': 'en' },
        remoteAddress: '10.9.8.7',
        payload: { phone, purpose: 'signup' },
      })
      expect(req.statusCode, req.body).toBe(200)
      expect(server.requests).toHaveLength(1)
      const recipient = (
        server.requests[0]!.json as { recipients: Array<{ mobiles: string; otp: string }> }
      ).recipients[0]!
      expect(`+${recipient.mobiles}`).toBe(phone)
      expect(recipient.otp).toMatch(/^\d{6}$/)
      const verify = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/verify',
        remoteAddress: '10.9.8.7',
        payload: { phone, code: recipient.otp, purpose: 'signup' },
      })
      expect(verify.statusCode, verify.body).toBe(200)
      expect(verify.json()).toMatchObject({ data: { otp_token: expect.any(String) } })

      // A provider failure surfaces as 502 PROVIDER_ERROR (the unsent code is discarded).
      server.respond.push({ status: 503, body: {} })
      const failed = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/otp/request',
        remoteAddress: '10.9.8.8',
        payload: { phone: randomPhone(), purpose: 'signup' },
      })
      expect(failed.statusCode, failed.body).toBe(502)
      expect(failed.json()).toMatchObject({ error: { code: 'PROVIDER_ERROR' } })
    } finally {
      await t.close()
    }
  })
})
