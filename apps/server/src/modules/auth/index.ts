/**
 * auth (foundation) module — docs/API.md "auth", ARCHITECTURE.md §7.4: signup (cloud), password
 * / OTP / PIN sign-in, password reset & change, tenant selection, refresh rotation, logout,
 * GET /me and the on-prem first-run wizard. Contracts: @kadai/shared/api/auth (`authRoutes`).
 *
 * Browser sessions: the access token is returned in the body (kept in memory by the web app);
 * the refresh token is the httpOnly SameSite=Strict cookie `kadai_rt` scoped to /api/v1/auth
 * (Secure when PUBLIC_BASE_URL is https). Cookie-based refresh / logout require the header
 * `X-Requested-With: kadai`. Non-browser clients send `X-Kadai-Token-Delivery: body` to receive
 * `refresh_token` in the body, and refresh with `{ refresh_token }` (answered in the body).
 */
import type { FastifyRequest } from 'fastify'
import type { OtpPurpose } from '@kadai/shared'
import { type AuthOtpPurpose, AuthOtpPurposeSchema, authRoutes } from '@kadai/shared/api/auth'
import { AppError, invalidField, isAppError, unauthenticated } from '../../core/errors'
import { type KadaiPlugin, RATE_LIMITS, route } from '../../core/http'
import { createTenant } from '../../core/onboarding'
import { defineModule } from '../module'
import { loadMe } from './me'
import {
  changePassword,
  logout,
  passwordLogin,
  pinLogin,
  pinUsers,
  refresh,
  requestOtp,
  resetPassword,
  selectTenant,
  verifyDevice,
  verifyOtp,
} from './service'
import {
  clearRefreshCookie,
  deliveryOf,
  presentedRefreshToken,
  requestMeta,
  respondWithSession,
  startSession,
} from './session'
import { runSetup, setupStatus } from './setup'

const byIp = (req: FastifyRequest): string => `ip:${req.ip}`

/** /auth/otp/* serve login, signup and reset_password only. */
function authOtpPurpose(purpose: OtpPurpose): AuthOtpPurpose {
  const parsed = AuthOtpPurposeSchema.safeParse(purpose)
  if (!parsed.success) throw invalidField('purpose', 'Unsupported OTP purpose')
  return parsed.data
}

/** Route rate limits (ARCHITECTURE.md §17) on top of the per-phone OTP throttle. */
export const AUTH_RATE_LIMITS = {
  signup: { max: 10, timeWindow: '1 hour', keyGenerator: byIp },
  /** OTP sends: 3 per 10 minutes per IP (and per phone, in the OTP service). */
  otpRequest: { max: 3, timeWindow: '10 minutes', keyGenerator: byIp },
  /** Counter PCs of a supermarket share one IP; the PIN itself locks after 5 failures. */
  pin: { max: 60, timeWindow: '1 minute', keyGenerator: byIp },
} as const

const routes: KadaiPlugin = async (app) => {
  const deps = app.kadai
  const userAuth = (req: FastifyRequest) => {
    if (req.auth?.kind !== 'user') throw unauthenticated()
    return req.auth
  }

  route(
    app,
    authRoutes.signup,
    async (req, reply) => {
      const body = req.body
      const meta = requestMeta(req)
      let phoneVerified = false
      if (body.otp_token) {
        const verified = await deps.otp.verifyOtpToken(body.otp_token, 'signup')
        if (verified.phone !== body.phone) {
          throw new AppError(
            'OTP_EXPIRED',
            'The verified mobile number differs from the signup number',
          )
        }
        phoneVerified = true
      } else if (deps.config.sms.provider !== 'log') {
        // With a real SMS provider configured, cloud signups must prove the mobile number.
        throw invalidField('otp_token', 'Verify your mobile number with the OTP first')
      }
      // system db: the tenant and owner do not exist yet (onboarding).
      const created = await createTenant(deps.db.systemDb, {
        business_name: body.business_name,
        business_name_ta: body.business_name_ta ?? null,
        business_type: body.business_type,
        gst_scheme: body.gst_scheme,
        gstin: body.gstin,
        state_code: body.state_code,
        locale: body.locale,
        owner: {
          full_name: body.owner_name,
          phone: body.phone,
          email: body.email ?? null,
          password: body.password,
        },
        phone_verified: phoneVerified,
        mode: 'cloud',
        meta: { ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId },
      })
      const session = await startSession(
        deps,
        reply,
        meta,
        {
          userId: created.user.id,
          tenantId: created.tenant.id,
          membershipId: created.membership.id,
          amr: phoneVerified ? ['password', 'otp'] : ['password'],
        },
        deliveryOf(req),
      )
      return { data: session }
    },
    { config: { rateLimit: AUTH_RATE_LIMITS.signup } },
  )

  route(
    app,
    authRoutes.login,
    async (req, reply) => {
      const meta = requestMeta(req)
      const subject = await passwordLogin(deps, meta, req.body)
      return { data: await startSession(deps, reply, meta, subject, deliveryOf(req)) }
    },
    { config: { rateLimit: RATE_LIMITS.login } },
  )

  route(
    app,
    authRoutes.otpRequest,
    async (req) => ({
      data: await requestOtp(deps, requestMeta(req), {
        phone: req.body.phone,
        purpose: authOtpPurpose(req.body.purpose),
      }),
    }),
    { config: { rateLimit: AUTH_RATE_LIMITS.otpRequest } },
  )

  route(
    app,
    authRoutes.otpVerify,
    async (req, reply) => {
      const meta = requestMeta(req)
      const result = await verifyOtp(deps, meta, {
        ...req.body,
        purpose: authOtpPurpose(req.body.purpose),
      })
      if (result.kind === 'token') return { data: result.token }
      return { data: await startSession(deps, reply, meta, result.subject, deliveryOf(req)) }
    },
    { config: { rateLimit: RATE_LIMITS.login } },
  )

  route(
    app,
    authRoutes.passwordReset,
    async (req, reply) => {
      await resetPassword(deps, requestMeta(req), req.body)
      clearRefreshCookie(reply, deps.config)
    },
    { config: { rateLimit: RATE_LIMITS.login } },
  )

  route(
    app,
    authRoutes.passwordChange,
    async (req) => {
      await changePassword(deps, requestMeta(req), userAuth(req), req.body)
    },
    {
      config: {
        auth: 'user',
        allowSuspended: true,
        allowReadOnly: true,
        rateLimit: RATE_LIMITS.login,
      },
    },
  )

  route(
    app,
    authRoutes.selectTenant,
    async (req, reply) => {
      const { subject, session } = await selectTenant(
        deps,
        requestMeta(req),
        userAuth(req),
        req.body.tenant_id,
      )
      return { data: await respondWithSession(deps, reply, subject, session, deliveryOf(req)) }
    },
    { config: { auth: 'user', allowSuspended: true, allowReadOnly: true } },
  )

  route(app, authRoutes.refresh, async (req, reply) => {
    const presented = presentedRefreshToken(req, req.body.refresh_token)
    if (!presented) throw unauthenticated('No refresh token')
    try {
      const { subject, session } = await refresh(deps, requestMeta(req), presented.token)
      return {
        data: await respondWithSession(
          deps,
          reply,
          subject,
          session,
          presented.via === 'body' ? 'body' : 'cookie',
        ),
      }
    } catch (err) {
      // A dead cookie is useless: drop it so the browser stops presenting it.
      if (presented.via === 'cookie' && isAppError(err) && err.status < 500) {
        clearRefreshCookie(reply, deps.config)
      }
      throw err
    }
  })

  route(
    app,
    authRoutes.logout,
    async (req, reply) => {
      const auth = req.auth?.kind === 'user' ? req.auth : null
      const presented = auth
        ? null
        : (presentedRefreshToken(req, req.body.refresh_token)?.token ?? null)
      await logout(deps, requestMeta(req), auth, presented, req.body.all)
      clearRefreshCookie(reply, deps.config)
    },
    { config: { auth: 'optional', allowSuspended: true, allowReadOnly: true } },
  )

  route(
    app,
    authRoutes.pinLogin,
    async (req, reply) => {
      const meta = requestMeta(req)
      const device = await verifyDevice(deps, req.body.device_id, req.body.device_secret)
      const subject = await pinLogin(deps, meta, device, req.body)
      return { data: await startSession(deps, reply, meta, subject, deliveryOf(req)) }
    },
    { config: { rateLimit: AUTH_RATE_LIMITS.pin } },
  )

  route(
    app,
    authRoutes.pinUsers,
    async (req) => {
      const device = await verifyDevice(deps, req.query.device_id, req.query.device_secret)
      return { data: await pinUsers(deps, device) }
    },
    { config: { rateLimit: AUTH_RATE_LIMITS.pin } },
  )

  route(app, authRoutes.me, async (req) => ({
    data: await req.tx((tx) => loadMe(deps, tx, req.ctx)),
  }))

  // Deployment probe (both modes); POST /setup is on-prem only (route() skips it in cloud → 404).
  route(app, authRoutes.setupStatus, async () => ({
    data: await setupStatus(deps.db.systemDb, deps.config, deps.version),
  }))

  route(
    app,
    authRoutes.setup,
    async (req, reply) => {
      const meta = requestMeta(req)
      // system db: the first tenant is being created (no tenant context exists yet).
      const created = await runSetup(deps.db.systemDb, deps.config, deps.version, meta, req.body)
      const session = await startSession(
        deps,
        reply,
        meta,
        {
          userId: created.user.id,
          tenantId: created.tenant.id,
          membershipId: created.membership.id,
          amr: ['password'],
        },
        deliveryOf(req),
      )
      return { data: session }
    },
    { config: { rateLimit: RATE_LIMITS.login } },
  )
}

export const authModule = defineModule({ name: 'auth', routes })
