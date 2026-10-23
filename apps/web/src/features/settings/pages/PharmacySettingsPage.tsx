/**
 * Pharmacy (/settings/pharmacy, pharmacy shops only): which drug schedules need a prescription
 * at billing (doctor and prescription captured on the bill) and whether the Schedule H1 register
 * is kept. Stock rules that matter most for medicines (FEFO, expired stock) are on POS & stock.
 */
import { ClipboardList, Pill, ScanBarcode } from 'lucide-react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { DrugSchedule, TenantSettings } from '@kadai/shared/settings'
import { Checkbox } from '@/components/ui'
import { SwitchField } from '../components/setting-fields'
import { SettingsCard } from '../components/SettingsCard'
import { SettingsField } from '../components/SettingsField'
import { SettingsFormShell } from '../components/SettingsFormShell'
import { useSettingsForm } from '../lib/use-settings-form'

const KEYS = ['pharmacy'] as const
/** Schedules a shop may require a prescription for (OTC never needs one). */
const RX_SCHEDULES = ['H', 'H1', 'X', 'G'] as const satisfies readonly DrugSchedule[]
type RxSchedule = (typeof RX_SCHEDULES)[number]
const rxOrder = (s: DrugSchedule): number => RX_SCHEDULES.indexOf(s as RxSchedule)

export default function PharmacySettingsPage() {
  const { t } = useTranslation('settings')
  const api = useSettingsForm(KEYS, t('pharmacy.saved'))
  return (
    <SettingsFormShell
      title={t('pages.pharmacy')}
      description={t('pharmacy.description')}
      api={api}
    >
      <SettingsCard
        id="pharmacy-rx"
        icon={<Pill />}
        title={t('pharmacy.section_rx')}
        description={t('pharmacy.section_rx_hint')}
      >
        <SettingsField name="pharmacy.require_rx_for_schedules" label={t('pharmacy.schedules')}>
          <Controller<Pick<TenantSettings, 'pharmacy'>, 'pharmacy.require_rx_for_schedules'>
            name="pharmacy.require_rx_for_schedules"
            render={({ field }) => (
              <div className="grid gap-2 sm:grid-cols-2">
                {RX_SCHEDULES.map((s) => {
                  const checked = field.value.includes(s)
                  return (
                    <div key={s} className="rounded-lg border border-border px-3 py-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) =>
                          field.onChange(
                            v === true
                              ? [...field.value, s].sort((a, b) => rxOrder(a) - rxOrder(b))
                              : field.value.filter((x) => x !== s),
                          )
                        }
                        label={t(`pharmacy.schedule_${s}`)}
                        description={t(`pharmacy.schedule_${s}_hint`)}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          />
        </SettingsField>
      </SettingsCard>
      <SettingsCard id="pharmacy-h1" icon={<ClipboardList />} title={t('pharmacy.section_h1')}>
        <SwitchField
          name="pharmacy.h1_register"
          label={t('pharmacy.h1_register')}
          description={t('pharmacy.h1_register_hint')}
        />
      </SettingsCard>
      <Link
        to="/settings/pos"
        className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:bg-surface-2"
      >
        <ScanBarcode className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t('pharmacy.stock_link')}</span>
      </Link>
    </SettingsFormShell>
  )
}
