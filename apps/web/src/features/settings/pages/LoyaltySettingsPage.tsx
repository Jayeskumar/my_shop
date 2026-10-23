/**
 * Loyalty & credit (/settings/loyalty): reward points (earn rate per ₹100, value of a point,
 * minimum to redeem, expiry) with a worked example, and khata credit defaults (credit days,
 * blocking bills over a customer's credit limit). Plan features loyalty / khata gate each part.
 */
import { Gift, Wallet } from 'lucide-react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { loyaltyPointsForAmount, loyaltyValuePaise } from '@kadai/shared/api/parties'
import { DEFAULT_SETTINGS, type TenantSettings } from '@kadai/shared/settings'
import { MoneyInput, NumberInput, Switch } from '@/components/ui'
import { useFeature } from '@/lib/auth'
import { formatMoney, formatNumber } from '@/lib/format'
import { NumberField, SwitchField, WithUnit } from '../components/setting-fields'
import { SettingsCard } from '../components/SettingsCard'
import { SettingsField } from '../components/SettingsField'
import { SettingsFormShell } from '../components/SettingsFormShell'
import { UpgradeHint } from '../components/UpgradeHint'
import { useSettingsForm } from '../lib/use-settings-form'

const KEYS = ['loyalty', 'credit'] as const
type Form = Pick<TenantSettings, 'loyalty' | 'credit'>

const EXAMPLE_BILL_PAISE = 100_000

function LoyaltyExample() {
  const { t } = useTranslation('settings')
  const loyalty = { ...DEFAULT_SETTINGS.loyalty, ...useWatch<Form, 'loyalty'>({ name: 'loyalty' }) }
  const points = loyaltyPointsForAmount(EXAMPLE_BILL_PAISE, { ...loyalty, enabled: true })
  return (
    <p
      className="rounded-lg bg-primary-soft px-3 py-2.5 text-sm text-primary-soft-foreground"
      aria-live="polite"
    >
      {t('loyalty.example', {
        bill: formatMoney(EXAMPLE_BILL_PAISE, { decimals: 0 }),
        points: formatNumber(points),
        value: formatMoney(loyaltyValuePaise(points, loyalty)),
        min: formatNumber(loyalty.min_redeem_points),
      })}
    </p>
  )
}

export default function LoyaltySettingsPage() {
  const { t } = useTranslation('settings')
  const api = useSettingsForm(KEYS, t('loyalty.saved'))
  const hasLoyalty = useFeature('loyalty')
  const hasKhata = useFeature('khata')
  const enabled = useWatch({ control: api.form.control, name: 'loyalty.enabled' })
  return (
    <SettingsFormShell title={t('pages.loyalty')} description={t('loyalty.description')} api={api}>
      <SettingsCard id="loyalty" icon={<Gift />} title={t('loyalty.section_points')}>
        {hasLoyalty ? (
          <>
            <SwitchField
              name="loyalty.enabled"
              label={t('loyalty.enabled')}
              description={t('loyalty.enabled_hint')}
            />
            {enabled ? (
              <>
                <div className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
                  <NumberField
                    name="loyalty.points_per_100_rupees"
                    label={t('loyalty.earn_rate')}
                    hint={t('loyalty.earn_rate_hint')}
                    min={0}
                    max={10_000}
                    unit={t('loyalty.points_suffix')}
                  />
                  <SettingsField
                    name="loyalty.point_value_paise"
                    label={t('loyalty.point_value')}
                    hint={t('loyalty.point_value_hint')}
                  >
                    <Controller<Form, 'loyalty.point_value_paise'>
                      name="loyalty.point_value_paise"
                      render={({ field }) => (
                        <MoneyInput
                          value={field.value}
                          onChange={(v) => field.onChange(v ?? 0)}
                          onBlur={field.onBlur}
                        />
                      )}
                    />
                  </SettingsField>
                  <NumberField
                    name="loyalty.min_redeem_points"
                    label={t('loyalty.min_redeem')}
                    hint={t('loyalty.min_redeem_hint')}
                    min={0}
                    unit={t('loyalty.points_suffix')}
                  />
                </div>
                <SettingsField name="loyalty.expiry_days" label={t('loyalty.expiry')}>
                  <Controller<Form, 'loyalty.expiry_days'>
                    name="loyalty.expiry_days"
                    render={({ field }) => (
                      <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <Switch
                            checked={field.value !== null}
                            onCheckedChange={(v) => field.onChange(v ? 365 : null)}
                            label={t('loyalty.expiry_on')}
                            description={
                              field.value === null
                                ? t('loyalty.expiry_never')
                                : t('loyalty.expiry_after', { count: field.value })
                            }
                          />
                        </div>
                        {field.value !== null ? (
                          <div className="sm:w-44">
                            <WithUnit unit={t('pos.days')}>
                              <NumberInput
                                value={field.value}
                                onChange={(v) => field.onChange(v ?? 1)}
                                onBlur={field.onBlur}
                                min={1}
                                max={3650}
                                aria-label={t('loyalty.expiry_days')}
                                className="tabular-nums"
                              />
                            </WithUnit>
                          </div>
                        ) : null}
                      </div>
                    )}
                  />
                </SettingsField>
                <LoyaltyExample />
              </>
            ) : null}
          </>
        ) : (
          <UpgradeHint block={{ kind: 'feature', feature: 'loyalty' }} />
        )}
      </SettingsCard>

      <SettingsCard id="credit" icon={<Wallet />} title={t('loyalty.section_credit')}>
        {hasKhata ? (
          <>
            <NumberField
              name="credit.default_credit_days"
              label={t('loyalty.credit_days')}
              hint={t('loyalty.credit_days_hint')}
              min={0}
              max={365}
              unit={t('pos.days')}
              className="max-w-56"
            />
            <SwitchField
              name="credit.block_over_limit"
              label={t('loyalty.block_over_limit')}
              description={t('loyalty.block_over_limit_hint')}
            />
          </>
        ) : (
          <UpgradeHint block={{ kind: 'feature', feature: 'khata' }} />
        )}
      </SettingsCard>
    </SettingsFormShell>
  )
}
