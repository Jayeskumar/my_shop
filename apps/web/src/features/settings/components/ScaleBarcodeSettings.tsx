/**
 * Weighing-scale barcode layout (settings.pos.scale_barcode): on/off, prefixes, digits for the
 * item code and the value, whether the value is a weight or a price and its unit — with a live
 * 13-digit layout check, a sample code and a test-scan box (scan a label from the shop's scale
 * to see how Kadai reads it).
 */
import { CheckCircle2, CircleAlert, ScanBarcode } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Controller, useFormContext, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { ScaleBarcodeConfig } from '@kadai/shared/scale'
import type { TenantSettings } from '@kadai/shared/settings'
import { Badge, Input, Select } from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/format'
import { badPrefixes, EAN13_LENGTH, layoutLength, sampleScaleBarcode, testScan } from '../lib/scale'
import { NumberField, RadioField, SwitchField } from './setting-fields'
import { SettingsField } from './SettingsField'

type Form = Pick<TenantSettings, 'pos'>

const WEIGHT_DIVISORS = [1000, 100, 10] as const
const PRICE_DIVISORS = [100, 10, 1] as const

/** Comma / space separated prefixes, edited as text and stored as an array of digit strings. */
function PrefixesInput() {
  const { t } = useTranslation('settings')
  const form = useFormContext<Form>()
  const value = useWatch({ control: form.control, name: 'pos.scale_barcode.prefixes' })
  const [text, setText] = useState(value.join(', '))
  const joined = value.join(', ')
  useEffect(() => {
    // Follow outside changes (reset / discard) without fighting the user's typing.
    setText((current) =>
      current
        .split(/[\s,]+/)
        .filter(Boolean)
        .join(', ') === joined
        ? current
        : joined,
    )
  }, [joined])
  return (
    <SettingsField
      name="pos.scale_barcode.prefixes"
      label={t('pos.scale_prefixes')}
      hint={t('pos.scale_prefixes_hint')}
    >
      <Input
        value={text}
        inputMode="numeric"
        className="font-mono"
        onChange={(e) => {
          setText(e.target.value)
          const parts = e.target.value.split(/[\s,]+/).filter(Boolean)
          form.setValue('pos.scale_barcode.prefixes', parts, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }}
      />
    </SettingsField>
  )
}

function TestScanBox({ cfg }: { cfg: ScaleBarcodeConfig }) {
  const { t } = useTranslation('settings')
  const [code, setCode] = useState('')
  const result = code.trim() ? testScan(code, cfg) : null
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface-2/50 p-3">
      <SettingsField label={t('pos.scale_test')} hint={t('pos.scale_test_hint')}>
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          maxLength={20}
          className="font-mono tracking-wider"
          placeholder="2100123012504"
          startAdornment={<ScanBarcode className="size-4 text-muted-foreground" aria-hidden />}
          aria-describedby="scale-test-result"
        />
      </SettingsField>
      <div id="scale-test-result" aria-live="polite" className="mt-2 min-h-5 text-sm">
        {result === null ? null : result.ok ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            {t('pos.scale_read_plu', { plu: result.parsed.plu })}
            {result.parsed.qty_milli !== undefined ? (
              <Badge tone="success">{formatQty(result.parsed.qty_milli, 'KG')}</Badge>
            ) : null}
            {result.parsed.price_paise !== undefined ? (
              <Badge tone="success">{formatMoney(result.parsed.price_paise)}</Badge>
            ) : null}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 text-danger">
            <CircleAlert className="size-4" aria-hidden />
            {t(`pos.scale_fail_${result.reason}`)}
          </span>
        )}
      </div>
    </div>
  )
}

export function ScaleBarcodeSettings() {
  const { t } = useTranslation('settings')
  const form = useFormContext<Form>()
  const cfg = useWatch({ control: form.control, name: 'pos.scale_barcode' })
  const bad = badPrefixes(cfg)
  const length = layoutLength(cfg)
  const sample = sampleScaleBarcode(cfg)
  return (
    <div className="flex flex-col gap-4">
      <SwitchField
        name="pos.scale_barcode.enabled"
        label={t('pos.scale_enabled')}
        description={t('pos.scale_enabled_hint')}
      />
      {cfg.enabled ? (
        <>
          <PrefixesInput />
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <NumberField
              name="pos.scale_barcode.item_code_length"
              label={t('pos.scale_item_digits')}
              min={1}
              max={10}
            />
            <NumberField
              name="pos.scale_barcode.value_length"
              label={t('pos.scale_value_digits')}
              min={1}
              max={10}
            />
          </div>
          <div
            className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm"
            aria-live="polite"
          >
            {bad.length === 0 ? (
              <Badge tone="success" icon={<CheckCircle2 />}>
                {t('pos.scale_layout_ok', { count: length, total: EAN13_LENGTH })}
              </Badge>
            ) : (
              <Badge tone="danger" icon={<CircleAlert />}>
                {t('pos.scale_layout_bad', { prefixes: bad.join(', '), total: EAN13_LENGTH })}
              </Badge>
            )}
            <span className="font-mono text-xs text-muted-foreground">
              {t('pos.scale_layout_pattern', {
                p: 'P'.repeat(cfg.prefixes[0]?.length ?? 2),
                i: 'I'.repeat(cfg.item_code_length),
                v: 'V'.repeat(cfg.value_length),
              })}
            </span>
            {sample ? (
              <span className="text-xs text-muted-foreground">
                {t('pos.scale_sample', { code: sample })}
              </span>
            ) : null}
          </div>
          <RadioField<'weight' | 'price'>
            name="pos.scale_barcode.value_type"
            label={t('pos.scale_value_type')}
            orientation="horizontal"
            options={[
              {
                value: 'weight',
                label: t('pos.scale_weight'),
                description: t('pos.scale_weight_hint'),
              },
              {
                value: 'price',
                label: t('pos.scale_price'),
                description: t('pos.scale_price_hint'),
              },
            ]}
          />
          {cfg.value_type === 'weight' ? (
            <SettingsField
              name="pos.scale_barcode.weight_unit_divisor"
              label={t('pos.scale_weight_unit')}
            >
              <Controller<Form, 'pos.scale_barcode.weight_unit_divisor'>
                name="pos.scale_barcode.weight_unit_divisor"
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                    options={[
                      ...WEIGHT_DIVISORS.map((d) => ({
                        value: String(d),
                        label: t(`pos.weight_divisor_${d}`),
                      })),
                      ...(WEIGHT_DIVISORS.includes(field.value as (typeof WEIGHT_DIVISORS)[number])
                        ? []
                        : [{ value: String(field.value), label: String(field.value) }]),
                    ]}
                  />
                )}
              />
            </SettingsField>
          ) : (
            <SettingsField name="pos.scale_barcode.price_divisor" label={t('pos.scale_price_unit')}>
              <Controller<Form, 'pos.scale_barcode.price_divisor'>
                name="pos.scale_barcode.price_divisor"
                render={({ field }) => (
                  <Select
                    value={String(field.value)}
                    onValueChange={(v) => field.onChange(Number(v))}
                    options={[
                      ...PRICE_DIVISORS.map((d) => ({
                        value: String(d),
                        label: t(`pos.price_divisor_${d}`),
                      })),
                      ...(PRICE_DIVISORS.includes(field.value as (typeof PRICE_DIVISORS)[number])
                        ? []
                        : [{ value: String(field.value), label: String(field.value) }]),
                    ]}
                  />
                )}
              />
            </SettingsField>
          )}
        </>
      ) : null}
      <TestScanBox cfg={cfg} />
    </div>
  )
}
