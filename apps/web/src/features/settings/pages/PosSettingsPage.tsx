/**
 * POS & stock (/settings/pos): stock rules (negative stock, FEFO, expiry warning, blocking
 * expired sale, low-stock alerts), billing-counter rules (price edit, cashier discount limit,
 * customer required for credit, default payment method, sound, open shift required), weighing
 * scale barcodes with a test scan, and the quick keys of the billing screen.
 */
import { Boxes, Keyboard, Scale, ShoppingCart } from 'lucide-react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { TenantSettings } from '@kadai/shared/settings'
import { useFeature } from '@/lib/auth'
import { QuickKeysEditor } from '../components/QuickKeysEditor'
import { ScaleBarcodeSettings } from '../components/ScaleBarcodeSettings'
import { NumberField, RadioField, SwitchField } from '../components/setting-fields'
import { SettingsCard } from '../components/SettingsCard'
import { SettingsFormShell } from '../components/SettingsFormShell'
import { useSettingsForm } from '../lib/use-settings-form'

const KEYS = ['inventory', 'pos'] as const

export default function PosSettingsPage() {
  const { t } = useTranslation('settings')
  const api = useSettingsForm(KEYS, t('pos.saved'))
  const batches = useFeature('batches_expiry')
  const shifts = useFeature('shifts')
  return (
    <SettingsFormShell title={t('pages.pos')} description={t('pos.description')} api={api}>
      <SettingsCard id="pos-stock" icon={<Boxes />} title={t('pos.section_stock')}>
        <SwitchField
          name="inventory.allow_negative_stock"
          label={t('pos.negative_stock')}
          description={t('pos.negative_stock_hint')}
        />
        <SwitchField
          name="inventory.low_stock_alerts"
          label={t('pos.low_stock_alerts')}
          description={t('pos.low_stock_alerts_hint')}
        />
        {batches ? (
          <>
            <SwitchField
              name="inventory.fefo"
              label={t('pos.fefo')}
              description={t('pos.fefo_hint')}
            />
            <SwitchField
              name="inventory.block_expired_sale"
              label={t('pos.block_expired')}
              description={t('pos.block_expired_hint')}
            />
            <NumberField
              name="inventory.expiry_warning_days"
              label={t('pos.expiry_warning_days')}
              hint={t('pos.expiry_warning_days_hint')}
              min={0}
              max={730}
              unit={t('pos.days')}
              className="max-w-56"
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('pos.batches_not_in_plan')}</p>
        )}
      </SettingsCard>

      <SettingsCard id="pos-billing" icon={<ShoppingCart />} title={t('pos.section_billing')}>
        <NumberField
          name="pos.max_discount_bp_without_override"
          label={t('pos.max_discount')}
          hint={t('pos.max_discount_hint')}
          scale={100}
          decimals={2}
          min={0}
          max={10_000}
          suffix="%"
          className="max-w-56"
        />
        <SwitchField
          name="pos.allow_price_edit"
          label={t('pos.price_edit')}
          description={t('pos.price_edit_hint')}
        />
        <SwitchField
          name="pos.require_customer_for_credit"
          label={t('pos.customer_for_credit')}
          description={t('pos.customer_for_credit_hint')}
        />
        <RadioField<'cash' | 'upi' | 'card'>
          name="pos.default_payment_method"
          label={t('pos.default_payment')}
          orientation="horizontal"
          options={[
            { value: 'cash', label: t('pos.pay_cash') },
            { value: 'upi', label: t('pos.pay_upi') },
            { value: 'card', label: t('pos.pay_card') },
          ]}
        />
        <SwitchField name="pos.sound" label={t('pos.sound')} description={t('pos.sound_hint')} />
        {shifts ? (
          <SwitchField
            name="pos.require_open_shift"
            label={t('pos.require_shift')}
            description={t('pos.require_shift_hint')}
          />
        ) : null}
      </SettingsCard>

      <SettingsCard
        id="pos-scale"
        icon={<Scale />}
        title={t('pos.section_scale')}
        description={t('pos.section_scale_hint')}
      >
        <ScaleBarcodeSettings />
      </SettingsCard>

      <SettingsCard
        id="pos-quick-keys"
        icon={<Keyboard />}
        title={t('pos.quick_keys')}
        description={t('pos.quick_keys_hint')}
      >
        <Controller<Pick<TenantSettings, 'pos'>, 'pos.quick_keys'>
          name="pos.quick_keys"
          render={({ field }) => (
            <QuickKeysEditor
              value={field.value}
              onChange={(next) => field.onChange(next)}
              disabled={!api.canEdit}
            />
          )}
        />
      </SettingsCard>
    </SettingsFormShell>
  )
}
