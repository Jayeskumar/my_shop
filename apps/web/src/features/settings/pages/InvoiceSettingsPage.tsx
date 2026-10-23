/**
 * Invoice & printing (/settings/invoice): paper format (58 / 80 mm thermal, A4), Tamil + English
 * printing, what the bill shows (HSN, MRP savings, UPI QR), round-off, default price entry
 * (incl. / excl. GST), footer in both languages, terms and number of copies — with a live
 * preview of a sample bill priced by the shared engine. POS & stock options live on their own
 * screen (linked).
 */
import { FileText, Printer, ReceiptText, ScanBarcode } from 'lucide-react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { DEFAULT_SETTINGS, type TenantSettings } from '@kadai/shared/settings'
import { Input } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { ReceiptPreview } from '../components/ReceiptPreview'
import { NumberField, RadioField, SwitchField } from '../components/setting-fields'
import { SettingsCard } from '../components/SettingsCard'
import { SettingsField } from '../components/SettingsField'
import { SettingsFormShell } from '../components/SettingsFormShell'
import { useSettingsForm } from '../lib/use-settings-form'

const KEYS = ['invoice'] as const

function LivePreview() {
  const invoice = useWatch<Pick<TenantSettings, 'invoice'>, 'invoice'>({ name: 'invoice' })
  return <ReceiptPreview invoice={{ ...DEFAULT_SETTINGS.invoice, ...invoice }} />
}

function TextField({
  name,
  label,
  hint,
  rows,
  maxLength,
  lang,
}: {
  name: 'invoice.footer_text' | 'invoice.footer_text_ta' | 'invoice.terms'
  label: string
  hint?: string
  rows?: number
  maxLength: number
  lang?: string
}) {
  return (
    <SettingsField name={name} label={label} hint={hint} optional>
      <Controller<Pick<TenantSettings, 'invoice'>, typeof name>
        name={name}
        render={({ field }) =>
          rows ? (
            <Textarea
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              rows={rows}
              maxLength={maxLength}
              lang={lang}
            />
          ) : (
            <Input
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
              onBlur={field.onBlur}
              maxLength={maxLength}
              lang={lang}
            />
          )
        }
      />
    </SettingsField>
  )
}

export default function InvoiceSettingsPage() {
  const { t } = useTranslation(['settings', 'nav'])
  const api = useSettingsForm(KEYS, t('invoice.saved'))
  return (
    <SettingsFormShell
      title={t('nav:titles.settings_invoice')}
      description={t('invoice.description')}
      api={api}
      aside={<LivePreview />}
      asideLabel={t('invoice.see_preview')}
    >
      <SettingsCard id="invoice-paper" icon={<Printer />} title={t('invoice.section_paper')}>
        <RadioField<'thermal_80' | 'thermal_58' | 'a4'>
          name="invoice.print_format"
          label={t('invoice.print_format')}
          hint={t('invoice.print_format_hint')}
          options={[
            {
              value: 'thermal_80',
              label: t('print_format.thermal_80'),
              description: t('invoice.format_80_hint'),
            },
            {
              value: 'thermal_58',
              label: t('print_format.thermal_58'),
              description: t('invoice.format_58_hint'),
            },
            { value: 'a4', label: t('print_format.a4'), description: t('invoice.format_a4_hint') },
          ]}
        />
        <NumberField
          name="invoice.copies"
          label={t('invoice.copies')}
          hint={t('invoice.copies_hint')}
          min={1}
          max={5}
          className="max-w-48"
        />
      </SettingsCard>

      <SettingsCard
        id="invoice-content"
        icon={<ReceiptText />}
        title={t('invoice.section_content')}
      >
        <SwitchField
          name="invoice.bilingual"
          label={t('invoice.bilingual')}
          description={t('invoice.bilingual_hint')}
        />
        <SwitchField
          name="invoice.show_hsn"
          label={t('invoice.show_hsn')}
          description={t('invoice.show_hsn_hint')}
        />
        <SwitchField
          name="invoice.show_mrp_savings"
          label={t('invoice.show_mrp_savings')}
          description={t('invoice.show_mrp_savings_hint')}
        />
        <SwitchField
          name="invoice.upi_qr_on_invoice"
          label={t('invoice.upi_qr')}
          description={t('invoice.upi_qr_hint')}
        />
      </SettingsCard>

      <SettingsCard id="invoice-amounts" icon={<FileText />} title={t('invoice.section_amounts')}>
        <RadioField<'nearest_rupee' | 'none'>
          name="invoice.round_off"
          label={t('invoice.round_off')}
          orientation="horizontal"
          options={[
            {
              value: 'nearest_rupee',
              label: t('invoice.round_nearest'),
              description: t('invoice.round_nearest_hint'),
            },
            {
              value: 'none',
              label: t('invoice.round_none'),
              description: t('invoice.round_none_hint'),
            },
          ]}
        />
        <SwitchField
          name="invoice.default_price_includes_tax"
          label={t('invoice.price_includes_tax')}
          description={t('invoice.price_includes_tax_hint')}
        />
      </SettingsCard>

      <SettingsCard id="invoice-footer" icon={<FileText />} title={t('invoice.section_footer')}>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <TextField
            name="invoice.footer_text_ta"
            label={t('invoice.footer_ta')}
            maxLength={500}
            lang="ta"
          />
          <TextField name="invoice.footer_text" label={t('invoice.footer_en')} maxLength={500} />
        </div>
        <TextField
          name="invoice.terms"
          label={t('invoice.terms')}
          hint={t('invoice.terms_hint')}
          rows={3}
          maxLength={2000}
        />
      </SettingsCard>

      <Link
        to="/settings/pos"
        className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground hover:bg-surface-2"
      >
        <ScanBarcode className="size-4 shrink-0" aria-hidden />
        <span className="flex-1">{t('invoice.pos_link')}</span>
      </Link>
    </SettingsFormShell>
  )
}
