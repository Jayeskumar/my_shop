import { KeyRound, Mail, UserRound } from 'lucide-react'
import { useFormContext } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { FormField, Input } from '@/components/ui'
import type { BusinessFormValues } from '../business-rules'
import { PasswordInput } from './PasswordInput'
import { PhoneInput } from './PhoneInput'

/** Owner account step: name, mobile, password, optional email (+ setup code on-prem). */
export function OwnerFields({ setupToken = false }: { setupToken?: boolean }) {
  const { t } = useTranslation('auth')
  const form = useFormContext<BusinessFormValues>()
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <FormField name="owner_name" label={t('signup.owner_name')} required>
        <Input
          size="lg"
          autoComplete="name"
          placeholder={t('signup.owner_name_placeholder')}
          startAdornment={<UserRound />}
          {...form.register('owner_name')}
        />
      </FormField>
      <FormField name="phone" label={t('signup.phone')} hint={t('signup.owner_hint')} required>
        <PhoneInput size="lg" placeholder={t('otp.phone_placeholder')} {...form.register('phone')} />
      </FormField>
      <FormField name="password" label={t('signup.password')} hint={t('signup.password_hint')} required>
        <PasswordInput size="lg" autoComplete="new-password" {...form.register('password')} />
      </FormField>
      <FormField name="email" label={t('signup.email')}>
        <Input
          size="lg"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder={t('signup.email_placeholder')}
          startAdornment={<Mail />}
          {...form.register('email')}
        />
      </FormField>
      {setupToken ? (
        <FormField name="setup_token" label={t('setup.setup_token')} hint={t('setup.setup_token_hint')} required className="sm:col-span-2">
          <Input
            size="lg"
            autoComplete="off"
            spellCheck={false}
            startAdornment={<KeyRound />}
            className="font-mono tracking-wider"
            {...form.register('setup_token')}
          />
        </FormField>
      ) : null}
    </div>
  )
}
