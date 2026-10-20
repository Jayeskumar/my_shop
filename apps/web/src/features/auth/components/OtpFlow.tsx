/**
 * Two-step OTP flow: mobile number → POST /auth/otp/request → 6-digit code with resend timer →
 * POST /auth/otp/verify. Used for OTP sign-in, password reset and signup phone verification.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { MessageSquareText } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { OtpVerifyResponse } from '@kadai/shared/api/auth'
import { zPhone } from '@kadai/shared/api/common'
import type { OtpPurpose } from '@kadai/shared/enums'
import { formatPhoneDisplay } from '@kadai/shared/phone'
import { Button, FormField, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { describeError } from '@/lib/errors'
import { localizeValidationMessage } from '@/lib/validation'
import { authApi } from '../api'
import { OtpCodeInput } from './OtpCodeInput'
import { PhoneInput } from './PhoneInput'

const PhoneFormSchema = z.object({ phone: zPhone })
type PhoneFormInput = z.input<typeof PhoneFormSchema>
type PhoneFormOutput = z.output<typeof PhoneFormSchema>

interface SentState {
  phone: string
  expiresAt: number
  resendAt: number
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function mmss(seconds: number): string {
  const s = Math.max(0, seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export interface OtpFlowProps {
  purpose: OtpPurpose
  /** Initial phone (E.164 or 10 digits). */
  phone?: string
  /** Don't allow changing the number (signup verification). */
  lockPhone?: boolean
  /** Send the OTP immediately for `phone` (skip the phone step). */
  autoSend?: boolean
  submitLabel?: string
  onVerified: (result: OtpVerifyResponse, phone: string) => void | Promise<void>
}

export function OtpFlow({
  purpose,
  phone,
  lockPhone,
  autoSend,
  submitLabel,
  onVerified,
}: OtpFlowProps) {
  const { t } = useTranslation(['auth', 'common'])
  const [sent, setSent] = useState<SentState | null>(null)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const now = useNow(sent !== null)
  const autoSent = useRef(false)

  const form = useForm<PhoneFormInput, unknown, PhoneFormOutput>({
    resolver: zodResolver(PhoneFormSchema),
    defaultValues: { phone: phone ? phone.replace(/^\+91/, '') : '' },
    mode: 'onTouched',
  })

  const send = async (e164: string): Promise<boolean> => {
    setSending(true)
    try {
      const res = await authApi.requestOtp({ phone: e164, purpose })
      const at = Date.now()
      setSent({
        phone: e164,
        expiresAt: at + res.expires_in * 1000,
        resendAt: at + res.resend_after * 1000,
      })
      setCode('')
      setCodeError(null)
      return true
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        form.setError('phone', {
          type: 'server',
          message: error.validationIssues[0]?.message ?? error.code,
        })
      } else {
        notify.error(error)
      }
      return false
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    if (!autoSend || !phone || autoSent.current) return
    autoSent.current = true
    const parsed = zPhone.safeParse(phone)
    if (parsed.success) void send(parsed.data)
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const verify = async (value: string): Promise<void> => {
    if (!sent || value.length !== 6 || verifying) return
    setVerifying(true)
    setCodeError(null)
    try {
      const result = await authApi.verifyOtp({ phone: sent.phone, code: value, purpose })
      await onVerified(result, sent.phone)
    } catch (error) {
      setCode('')
      if (
        isApiError(error) &&
        (error.code === 'OTP_INVALID' ||
          error.code === 'OTP_EXPIRED' ||
          error.code === 'VALIDATION_ERROR')
      ) {
        setCodeError(error.code === 'VALIDATION_ERROR' ? describeError(error).title : error.code)
      } else {
        notify.error(error)
      }
    } finally {
      setVerifying(false)
    }
  }

  if (!sent) {
    return (
      <FormProvider {...form}>
        <form
          noValidate
          className="grid gap-5"
          onSubmit={form.handleSubmit(async (values) => {
            await send(values.phone)
          })}
        >
          <FormField name="phone" label={t('otp.phone')} required>
            <PhoneInput
              size="lg"
              placeholder={t('otp.phone_placeholder')}
              autoFocus
              disabled={lockPhone}
              {...form.register('phone')}
            />
          </FormField>
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={sending}
            leftIcon={<MessageSquareText />}
          >
            {t('otp.send')}
          </Button>
        </form>
      </FormProvider>
    )
  }

  const secondsToResend = Math.ceil((sent.resendAt - now) / 1000)
  const secondsToExpiry = Math.ceil((sent.expiresAt - now) / 1000)
  const expired = secondsToExpiry <= 0
  // codeError holds an API error code (OTP_INVALID / OTP_EXPIRED) or an already-localized text.
  const errorText = codeError ? localizeValidationMessage(codeError) : null

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        void verify(code)
      }}
    >
      <p className="text-[15px] text-muted-foreground">
        {t('otp.sent_to', { phone: formatPhoneDisplay(sent.phone, { withCountryCode: true }) })}
      </p>
      <OtpCodeInput
        value={code}
        onChange={(v) => {
          setCode(v)
          setCodeError(null)
        }}
        onComplete={(v) => void verify(v)}
        disabled={verifying}
        invalid={Boolean(codeError)}
        autoFocus
        aria-describedby="otp-status"
      />
      <div
        id="otp-status"
        className="flex min-h-5 flex-wrap items-center justify-between gap-2 text-sm"
        aria-live="polite"
      >
        {codeError ? (
          <span role="alert" className="font-medium text-danger">
            {errorText}
          </span>
        ) : expired ? (
          <span className="text-danger">{t('otp.expired')}</span>
        ) : (
          <span className="text-muted-foreground">
            {t('otp.expires_in', { time: mmss(secondsToExpiry) })}
          </span>
        )}
        {secondsToResend > 0 && !expired ? (
          <span className="text-muted-foreground tabular-nums">
            {t('otp.resend_in', { seconds: secondsToResend })}
          </span>
        ) : (
          <Button
            variant="link"
            size="sm"
            loading={sending}
            onClick={async () => {
              if (await send(sent.phone)) notify.success(t('otp.resent'))
            }}
          >
            {t('otp.resend')}
          </Button>
        )}
      </div>
      {import.meta.env.DEV ? (
        <p className="text-xs text-muted-foreground">{t('otp.dev_hint')}</p>
      ) : null}
      <Button
        type="submit"
        size="lg"
        fullWidth
        loading={verifying}
        disabled={code.length !== 6 || expired}
      >
        {submitLabel ?? t('otp.verify')}
      </Button>
      {!lockPhone ? (
        <Button
          variant="ghost"
          onClick={() => {
            setSent(null)
            setCode('')
            setCodeError(null)
          }}
        >
          {t('otp.change_number')}
        </Button>
      ) : null}
    </form>
  )
}
