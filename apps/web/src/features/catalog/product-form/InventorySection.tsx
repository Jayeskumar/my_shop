/**
 * Stock settings: track stock, batches & expiry (pharmacy), reorder level / quantity, weighing
 * scale PLU, the current stock of the store and — for new products — the opening stock.
 */
import { adjustmentPrefillPath } from '@kadai/shared/api/inventory'
import { Boxes, Scale, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Input, Qty, QtyInput, Switch } from '@/components/ui'
import { useCan, useCurrentStore, useFeature } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { Field } from '../components/Field'
import { packUnitFor } from '../lib/format'
import { Section } from '../components/FormChrome'
import { LinkButton } from '../components/LinkButton'
import { useProductForm, useProductFormEnv } from './env'

export function InventorySection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const store = useCurrentStore()
  const canAdjust = useCan('inventory.adjust')
  const hasBatches = useFeature('batches_expiry')
  const hasInventory = useFeature('inventory')
  const { control, register, watch } = useProductForm()
  const kind = watch('kind')
  const unit = watch('unit')
  const track = watch('track_inventory')
  const batches = watch('track_batches')
  const weighed = watch('is_weighed')
  const decimal = watch('decimal_qty')
  const product = env.product

  if (kind === 'service') {
    return (
      <Section id="inventory" icon={icon} title={t('form.sections.inventory')}>
        <p className="text-sm text-muted-foreground">{t('inventory.service_note')}</p>
      </Section>
    )
  }
  const parent = kind === 'variant_parent'

  return (
    <Section
      id="inventory"
      icon={icon}
      title={t('form.sections.inventory')}
      description={parent ? t('inventory.parent_note') : t('form.sections.inventory_hint')}
      actions={
        env.mode === 'edit' && product && canAdjust && !parent && track ? (
          <LinkButton
            to={adjustmentPrefillPath({
              kind: 'adjustment',
              ...(store ? { store_id: store.id } : {}),
              product_ids: [product.id],
            })}
            variant="outline"
            size="sm"
            icon={<SlidersHorizontal />}
          >
            {t('inventory.adjust')}
          </LinkButton>
        ) : null
      }
    >
      <div className="grid grid-cols-1 gap-4">
        {env.mode === 'edit' &&
        product &&
        !parent &&
        product.track_inventory &&
        product.stock_qty_milli !== null ? (
          <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-4 py-3">
            <Boxes className="size-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-xs text-muted-foreground">
                {t('inventory.stock_in', {
                  store: store ? localizedName(store.name, store.name_ta) : '',
                })}
              </p>
              <p
                className={
                  product.stock_qty_milli <= 0
                    ? 'text-lg font-semibold text-danger'
                    : 'text-lg font-semibold'
                }
              >
                <Qty
                  milli={product.stock_qty_milli}
                  unit={product.unit}
                  packSize={product.pack_size}
                  packUnit={packUnitFor(env.businessType, product.unit)}
                />
              </p>
            </div>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {!parent ? (
            <Controller
              control={control}
              name="track_inventory"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={env.readOnly}
                  label={t('inventory.track')}
                  description={t('inventory.track_hint')}
                />
              )}
            />
          ) : null}
          {hasBatches ? (
            <Controller
              control={control}
              name="track_batches"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={env.readOnly || (!parent && !track)}
                  label={t('inventory.batches')}
                  description={
                    env.businessType === 'pharmacy'
                      ? t('inventory.batches_pharmacy')
                      : t('inventory.batches_hint')
                  }
                />
              )}
            />
          ) : null}
        </div>
        {!parent && track ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              name="reorder_level_milli"
              label={t('fields.reorder_level')}
              optional
              hint={t('inventory.reorder_level_hint')}
            >
              <Controller
                control={control}
                name="reorder_level_milli"
                render={({ field }) => (
                  <QtyInput
                    value={field.value}
                    onChange={field.onChange}
                    unit={unit}
                    allowDecimal={decimal}
                    min={0}
                    steppers={false}
                    disabled={env.readOnly}
                  />
                )}
              />
            </Field>
            <Field
              name="reorder_qty_milli"
              label={t('fields.reorder_qty')}
              optional
              hint={t('inventory.reorder_qty_hint')}
            >
              <Controller
                control={control}
                name="reorder_qty_milli"
                render={({ field }) => (
                  <QtyInput
                    value={field.value}
                    onChange={field.onChange}
                    unit={unit}
                    allowDecimal={decimal}
                    min={0}
                    steppers={false}
                    disabled={env.readOnly}
                  />
                )}
              />
            </Field>
          </div>
        ) : null}
        {!parent ? (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2 sm:items-start">
            <Controller
              control={control}
              name="is_weighed"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={env.readOnly}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Scale className="size-4" aria-hidden />
                      {t('inventory.weighed')}
                    </span>
                  }
                  description={t('inventory.weighed_hint')}
                />
              )}
            />
            {weighed ? (
              <Field
                name="scale_plu"
                label={t('fields.scale_plu')}
                hint={t('inventory.scale_plu_hint')}
              >
                <Input
                  {...register('scale_plu')}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="1042"
                  disabled={env.readOnly}
                  className="font-mono"
                />
              </Field>
            ) : null}
          </div>
        ) : null}
        {env.mode === 'create' && !parent && track && hasInventory && canAdjust ? (
          batches ? (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted-foreground">
              {t('inventory.opening_batches_note')}
            </p>
          ) : (
            <Field
              name="opening_stock_milli"
              label={t('fields.opening_stock')}
              optional
              hint={t('inventory.opening_hint', {
                store: store ? localizedName(store.name, store.name_ta) : '',
              })}
              className="sm:max-w-xs"
            >
              <Controller
                control={control}
                name="opening_stock_milli"
                render={({ field }) => (
                  <QtyInput
                    value={field.value}
                    onChange={field.onChange}
                    unit={unit}
                    allowDecimal={decimal}
                    min={0}
                  />
                )}
              />
            </Field>
          )
        ) : null}
      </div>
    </Section>
  )
}
