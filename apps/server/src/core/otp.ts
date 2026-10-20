/**
 * One-time passwords for login / signup / password reset / phone verification
 * (ARCHITECTURE.md §7.4, §17).
 *
 * * 6-digit codes from a CSPRNG, stored only as HMAC-SHA256(server key, purpose:phone:code); the
 *   server key is derived from JWT_SECRET (HKDF, purpose 'otp').
 * * TTL 5 minutes, 5 verification attempts, purpose-scoped; the LATEST code for (phone, purpose)
 *   wins — requesting a new code makes earlier ones unusable.
 * * Per-phone throttling: 30 s between requests, at most 3 requests per 10 minutes (per-IP limits
 *   are route rate limits).
 * * Delivery through an injectable {@link OtpSender}: 'log' (development: the code is logged
 *   outside production), MSG91 (DLT-registered OTP template), or a memory sender in tests.
 * * Verified signup/reset codes are exchanged for a short-lived signed `otp_token`.
 *
 * otp_codes is a system-only table: the service uses the SYSTEM database.
 */
import { randomInt } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { type OtpPurpose, maskPhone } from '@kadai/shared'
import type { Config } from '../config'
import type { DB } from '../db/schema.generated'
import { withSystemTx } from '../db/tenant'
import { deriveKey, hmacSha256Hex, timingSafeEqualStr } from './crypto'
import { AppError, rateLimited } from './errors'

export const OTP_TTL_SECONDS = 300
export const OTP_MAX_ATTEMPTS = 5
export const OTP_RESEND_AFTER_SECONDS = 30
export const OTP_WINDOW_SECONDS = 600
export const OTP_MAX_PER_WINDOW = 3
export const OTP_TOKEN_TTL_SECONDS = 600

export interface OtpMessage {
  phone: string
  code: string
  purpose: OtpPurpose
  locale: 'ta' | 'en'
  expiresInSeconds: number
}

/** Delivers OTP codes (SMS). Implementations must not log the code in production. */
export interface OtpSender {
  readonly name: string
  send(message: OtpMessage): Promise<void>
}

export interface OtpLogger {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
}

/** Development sender: logs the code (never in production). */
export function createLogOtpSender(logger: OtpLogger, opts: { revealCode: boolean }): OtpSender {
  return {
    name: 'log',
    async send(m) {
      if (opts.revealCode) {
        logger.info(
          { phone: maskPhone(m.phone), purpose: m.purpose, otp_code: m.code },
          'OTP (development: not sent)',
        )
      } else {
        logger.warn(
          { phone: maskPhone(m.phone), purpose: m.purpose },
          'OTP not delivered: SMS_PROVIDER=log',
        )
      }
    },
  }
}

/** Test sender: keeps the last code per phone+purpose in memory. */
export interface MemoryOtpSender extends OtpSender {
  readonly sent: OtpMessage[]
  lastCode(phone: string, purpose?: OtpPurpose): string | null
}

export function createMemoryOtpSender(): MemoryOtpSender {
  const sent: OtpMessage[] = []
  return {
    name: 'memory',
    sent,
    async send(m) {
      sent.push(m)
    },
    lastCode(phone, purpose) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const m = sent[i]!
        if (m.phone === phone && (!purpose || m.purpose === purpose)) return m.code
      }
      return null
    },
  }
}

/**
 * MSG91 OTP delivery via the Flow API with a DLT-registered template that has a `##otp##`
 * (variable `otp`) placeholder.
 */
export function createMsg91OtpSender(
  cfg: Config['sms']['msg91'],
  fetchImpl: typeof fetch = fetch,
): OtpSender {
  if (!cfg.authKey || !cfg.otpTemplateId)
    throw new Error('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required')
  const authKey = cfg.authKey
  const templateId = cfg.otpTemplateId
  return {
    name: 'msg91',
    async send(m) {
      const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: {
          authkey: authKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          template_id: templateId,
          short_url: '0',
          recipients: [
            {
              mobiles: m.phone.replace(/^\+/, ''),
              otp: m.code,
              minutes: String(Math.round(m.expiresInSeconds / 60)),
            },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        throw new AppError('PROVIDER_ERROR', `MSG91 responded ${res.status}`, { provider: 'msg91' })
      }
    },
  }
}

export function createOtpSender(
  config: Pick<Config, 'sms' | 'isProduction'>,
  logger: OtpLogger,
): OtpSender {
  return config.sms.provider === 'msg91'
    ? createMsg91OtpSender(config.sms.msg91)
    : createLogOtpSender(logger, { revealCode: !config.isProduction })
}

export interface OtpServiceOptions {
  systemDb: Kysely<DB>
  config: Pick<Config, 'auth'>
  sender: OtpSender
  now?: () => Date
}

export interface OtpRequestResult {
  otp_id: string
  expires_in: number
  resend_after: number
}

export class OtpService {
  private readonly key: Buffer
  private readonly tokenKey: Uint8Array

  constructor(private readonly opts: OtpServiceOptions) {
    this.key = deriveKey(opts.config.auth.jwtSecret, 'otp')
    this.tokenKey = new Uint8Array(deriveKey(opts.config.auth.jwtSecret, 'otp-token'))
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date()
  }

  private hash(phone: string, purpose: OtpPurpose, code: string): string {
    return hmacSha256Hex(this.key, `${purpose}:${phone}:${code}`)
  }

  /**
   * Issues and sends a code. @throws RATE_LIMITED (with retry_after_seconds) when the phone asked
   * too recently or too often. If delivery fails the code is deleted and the error propagates.
   */
  async request(input: {
    phone: string
    purpose: OtpPurpose
    ip?: string | null
    locale?: 'ta' | 'en'
  }): Promise<OtpRequestResult> {
    const now = this.now()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const id = await withSystemTx(this.opts.systemDb, async (tx) => {
      // Serialise requests per phone so the throttle check cannot be raced.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`kadai_otp:${input.phone}`}, 0))`.execute(
        tx,
      )
      const recent = await tx
        .selectFrom('otp_codes')
        .select(['created_at'])
        .where('phone', '=', input.phone)
        .where('created_at', '>', new Date(now.getTime() - OTP_WINDOW_SECONDS * 1000))
        .orderBy('created_at', 'desc')
        .execute()
      const last = recent[0]
      if (last) {
        const since = (now.getTime() - last.created_at.getTime()) / 1000
        if (since < OTP_RESEND_AFTER_SECONDS)
          throw rateLimited(Math.ceil(OTP_RESEND_AFTER_SECONDS - since))
      }
      if (recent.length >= OTP_MAX_PER_WINDOW) {
        const oldest = recent[recent.length - 1]!
        const retry = OTP_WINDOW_SECONDS - (now.getTime() - oldest.created_at.getTime()) / 1000
        throw rateLimited(Math.max(1, Math.ceil(retry)))
      }
      const row = await tx
        .insertInto('otp_codes')
        .values({
          phone: input.phone,
          purpose: input.purpose,
          code_hash: this.hash(input.phone, input.purpose, code),
          max_attempts: OTP_MAX_ATTEMPTS,
          expires_at: new Date(now.getTime() + OTP_TTL_SECONDS * 1000),
          ip: input.ip && /^[0-9a-fA-F:.]{2,45}$/.test(input.ip) ? input.ip : null,
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return row.id
    })
    try {
      await this.opts.sender.send({
        phone: input.phone,
        code,
        purpose: input.purpose,
        locale: input.locale ?? 'ta',
        expiresInSeconds: OTP_TTL_SECONDS,
      })
    } catch (err) {
      await this.opts.systemDb.deleteFrom('otp_codes').where('id', '=', id).execute()
      throw err instanceof AppError
        ? err
        : new AppError(
            'PROVIDER_ERROR',
            'Could not send the OTP',
            { provider: this.opts.sender.name },
            { cause: err },
          )
    }
    return { otp_id: id, expires_in: OTP_TTL_SECONDS, resend_after: OTP_RESEND_AFTER_SECONDS }
  }

  /**
   * Verifies the latest code for (phone, purpose) and consumes it.
   * @throws OTP_INVALID (wrong code; details.attempts_left) / OTP_EXPIRED (expired, consumed,
   *         attempts exhausted or no code requested).
   */
  async verify(input: {
    phone: string
    purpose: OtpPurpose
    code: string
  }): Promise<{ otp_id: string }> {
    const now = this.now()
    const outcome = await withSystemTx(this.opts.systemDb, async (tx) => {
      const row = await tx
        .selectFrom('otp_codes')
        .selectAll()
        .where('phone', '=', input.phone)
        .where('purpose', '=', input.purpose)
        .orderBy('created_at', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst()
      if (
        !row ||
        row.consumed_at ||
        row.expires_at.getTime() <= now.getTime() ||
        row.attempts >= row.max_attempts
      ) {
        return {
          ok: false as const,
          error: new AppError('OTP_EXPIRED', 'The OTP has expired; request a new one'),
        }
      }
      const valid =
        /^\d{6}$/.test(input.code) &&
        timingSafeEqualStr(row.code_hash, this.hash(input.phone, input.purpose, input.code))
      if (!valid) {
        // Recorded even though the request fails (returned, not thrown, so the update commits).
        await tx
          .updateTable('otp_codes')
          .set({ attempts: row.attempts + 1 })
          .where('id', '=', row.id)
          .execute()
        const left = row.max_attempts - row.attempts - 1
        return {
          ok: false as const,
          error:
            left > 0
              ? new AppError('OTP_INVALID', 'The OTP is incorrect', { attempts_left: left })
              : new AppError('OTP_EXPIRED', 'Too many wrong attempts; request a new OTP'),
        }
      }
      await tx
        .updateTable('otp_codes')
        .set({ consumed_at: now, attempts: row.attempts + 1 })
        .where('id', '=', row.id)
        .execute()
      return { ok: true as const, id: row.id }
    })
    if (!outcome.ok) throw outcome.error
    return { otp_id: outcome.id }
  }

  /** Short-lived proof that `phone` passed OTP verification for `purpose` (signup / reset). */
  async issueOtpToken(
    phone: string,
    purpose: OtpPurpose,
    otpId: string,
  ): Promise<{ otp_token: string; expires_in: number }> {
    const iat = Math.floor(this.now().getTime() / 1000)
    const token = await new SignJWT({ phone, purpose })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('kadai')
      .setAudience('kadai-otp')
      .setJti(otpId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + OTP_TOKEN_TTL_SECONDS)
      .sign(this.tokenKey)
    return { otp_token: token, expires_in: OTP_TOKEN_TTL_SECONDS }
  }

  /** Validates an otp_token for the expected purpose; returns the verified phone and OTP id. */
  async verifyOtpToken(
    token: string,
    purpose: OtpPurpose,
  ): Promise<{ phone: string; otp_id: string }> {
    try {
      const { payload } = await jwtVerify(token, this.tokenKey, {
        issuer: 'kadai',
        audience: 'kadai-otp',
        algorithms: ['HS256'],
        currentDate: this.now(),
      })
      if (
        payload.purpose !== purpose ||
        typeof payload.phone !== 'string' ||
        typeof payload.jti !== 'string'
      ) {
        throw new Error('wrong purpose')
      }
      return { phone: payload.phone, otp_id: payload.jti }
    } catch {
      throw new AppError('OTP_EXPIRED', 'Phone verification expired; verify the OTP again')
    }
  }
}
