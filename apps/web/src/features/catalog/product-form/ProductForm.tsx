/**
 * Product form (new and edit): section cards with a sticky save bar, Ctrl+S, unsaved-changes
 * guard, contract validation (lib/product-form.ts) and server error mapping. A new product may
 * also post its opening stock and generate its size × colour variants right after the create.
 */
import { newId } from '@kadai/shared/ids'
import { type ProductDetail, catalogRoutes } from '@kadai/shared/api/catalog'
import { inventoryRoutes } from '@kadai/shared/api/inventory'
import {
  Barcode,
  Boxes,
  FileText,
  IndianRupee,
  Layers,
  Package,
  Percent,
  Ruler,
  Tag,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button, notify } from '@/components/ui'
import { callRoute, isApiError } from '@/lib/api'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { useHotkeys } from '@/lib/hotkeys'
import { invalidateRoutes, useRouteMutation } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import { SaveBar, UnsavedChangesGuard } from '../components/FormChrome'
import { catalogReasonText } from '../lib/messages'
import {
  type ProductFormMode,
  type ProductFormValues,
  productResolver,
  toCreateBody,
  toUpdateBody,
  valuesFromProduct,
  withAttributeKeys,
} from '../lib/product-form'
import {
  type VariantDraft,
  buildVariantGenerate,
  defaultAxes,
  emptyVariantDraft,
} from '../lib/variants'
import { ATTRIBUTE_FIELDS } from '../lib/attributes'
import { AttributesSection } from './AttributesSection'
import { BarcodesSection } from './BarcodesSection'
import { BasicSection } from './BasicSection'
import { ProductFormEnvContext, type ProductFormEnv } from './env'
import { InventorySection } from './InventorySection'
import { PricingSection } from './PricingSection'
import { TaxSection } from './TaxSection'
import { UnitsSection } from './UnitsSection'
import { VariantMatrixEditor, VariantsSection } from './VariantsSection'
import { Section } from '../components/FormChrome'

const FORM_ID = 'catalog-product-form'

/** Fields a server VALIDATION_ERROR / DUPLICATE may point at. */
const DUPLICATE_FIELD: Record<string, keyof ProductFormValues> = {
  sku_taken: 'sku',
  barcode_taken: 'barcodes',
  scale_plu_taken: 'scale_plu',
}

/** 409 reasons whose `details.field` names the form field that cannot change. */
const FIELD_REASONS = new Set(['unit_in_use', 'pack_size_in_use', 'stock_on_hand'])

export interface ProductFormProps {
  mode: ProductFormMode
  product: ProductDetail | null
  defaults: ProductFormValues
  storeId: string | null
}

export function ProductForm({ mode, product, defaults, storeId }: ProductFormProps) {
  const { t } = useTranslation(['catalog', 'common'])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const me = useMe()
  const canWrite = useCan('catalog.write')
  const canAdjust = useCan('inventory.adjust')
  const hasVariants = useFeature('variants')
  const settings = me!.settings
  const businessType = me!.tenant.business_type
  const ctx = useMemo(() => ({ settings, businessType }), [settings, businessType])
  const readOnly = !canWrite
  const formRef = useRef<HTMLFormElement>(null)
  const afterSave = useRef<'open' | 'new'>('open')
  /** Set right before leaving after a successful create (the guard must not ask). */
  const leaving = useRef(false)
  const [idempotencyKey] = useState(() => newId())
  const [saving, setSaving] = useState(false)
  const [variantDraft, setVariantDraft] = useState<VariantDraft>(() =>
    emptyVariantDraft(defaultAxes(settings.catalog.variant_axes, businessType)),
  )

  const attributeKeys = useMemo(
    () => ATTRIBUTE_FIELDS[businessType].map((f) => f.key),
    [businessType],
  )
  const prepare = (v: ProductFormValues): ProductFormValues => withAttributeKeys(v, attributeKeys)
  const form = useForm<ProductFormValues>({
    defaultValues: prepare(defaults),
    resolver: productResolver(mode, ctx),
    mode: 'onTouched',
  })
  const kind = form.watch('kind')
  /** Values the form was loaded / last saved with (the PATCH diff base). */
  const baseline = useRef<ProductFormValues>(prepare(defaults))

  // A refetch of the product (barcode / variant changes, another device) refreshes an untouched
  // form; edits in progress are kept and only the changed fields are sent.
  useEffect(() => {
    if (mode !== 'edit' || !product || form.formState.isDirty) return
    const fresh = prepare(valuesFromProduct(product))
    baseline.current = fresh
    form.reset(fresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the stored row changes
  }, [product?.updated_at])

  const env = useMemo<ProductFormEnv>(
    () => ({ mode, product, readOnly, storeId, hasVariantsFeature: hasVariants, ...ctx }),
    [mode, product, readOnly, storeId, hasVariants, ctx],
  )

  const create = useRouteMutation(catalogRoutes.createProduct, {
    invalidates: [catalogRoutes.listProducts],
    onError: (error) => handleError(error),
  })
  const update = useRouteMutation(catalogRoutes.updateProduct, {
    invalidates: [catalogRoutes.listProducts, catalogRoutes.getProduct],
    onError: (error) => handleError(error),
  })

  function handleError(error: unknown): void {
    if (isApiError(error)) {
      if (error.code === 'VALIDATION_ERROR' && error.validationIssues.length) {
        let mapped = false
        for (const issue of error.validationIssues) {
          const [head, ...rest] = issue.path.split('.')
          const field = head === 'brand_id' ? 'brand' : head
          if (field && field in defaults) {
            form.setError([field, ...rest].join('.') as keyof ProductFormValues, {
              type: 'server',
              message: issue.message,
            })
            mapped = true
          }
        }
        if (mapped) {
          notify.error(t('form.fix_errors'))
          return
        }
      }
      const reason = typeof error.details?.reason === 'string' ? error.details.reason : null
      const field = reason ? DUPLICATE_FIELD[reason] : undefined
      if (field && field !== 'barcodes') {
        form.setError(field, { type: 'server', message: catalogReasonText(error) ?? reason ?? '' })
        form.setFocus(field)
        return
      }
      // A field that cannot change any more (stock exists): mark it and explain in a toast
      // (switches have no inline message).
      const locked =
        reason && FIELD_REASONS.has(reason) && typeof error.details?.field === 'string'
          ? error.details.field
          : undefined
      if (locked && locked in defaults) {
        const text = catalogReasonText(error) ?? error.message
        form.setError(locked as keyof ProductFormValues, { type: 'server', message: text })
        notify.error(text)
        return
      }
      if (error.code === 'STALE_WRITE') {
        notify.error(error, {
          description: t('form.stale'),
          action: { label: t('form.reload'), onClick: () => window.location.reload() },
        })
        return
      }
      const text = catalogReasonText(error)
      if (text) {
        notify.error(text)
        return
      }
    }
    notify.error(error)
  }

  const save = async (values: ProductFormValues): Promise<void> => {
    if (mode === 'edit' && product) {
      const body = toUpdateBody(values, baseline.current, product)
      if (!body) {
        notify.info(t('form.no_changes'))
        return
      }
      setSaving(true)
      try {
        const res = await update.mutateAsync({ params: { id: product.id }, body })
        const saved = prepare(valuesFromProduct(res.data))
        baseline.current = saved
        form.reset(saved)
        notify.success(t('form.saved', { name: res.data.name }))
      } catch {
        // handled in onError
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    try {
      const res = await create.mutateAsync({ body: toCreateBody(values), idempotencyKey })
      const created = res.data
      const followUps: Promise<void>[] = []
      if (
        values.opening_stock_milli &&
        values.opening_stock_milli > 0 &&
        canAdjust &&
        storeId &&
        created.track_inventory &&
        !created.track_batches &&
        created.kind !== 'variant_parent'
      ) {
        followUps.push(
          callRoute(inventoryRoutes.postOpeningStock, {
            body: {
              store_id: storeId,
              lines: [
                {
                  product_id: created.id,
                  qty_milli: values.opening_stock_milli,
                  unit_cost_paise: created.purchase_price_paise,
                },
              ],
            },
            idempotencyKey: newId(),
          }).then(
            () => undefined,
            (error: unknown) => {
              notify.warning(t('form.opening_failed'), {
                description: isApiError(error) ? error.message : undefined,
              })
            },
          ),
        )
      }
      if (created.kind === 'variant_parent' && variantDraft.axes.some((a) => a.values.length)) {
        const firstAxis = variantDraft.axes.find((a) => a.values.length)?.name ?? null
        const { body, error } = buildVariantGenerate({
          axes: variantDraft.axes,
          priceAxis: firstAxis,
          prices: variantDraft.prices,
          generateBarcodes: variantDraft.generateBarcodes,
        })
        if (!error)
          followUps.push(
            callRoute(catalogRoutes.generateVariants, { params: { id: created.id }, body }).then(
              (r) => {
                notify.success(t('variants.generated', { count: r.data.created.length }))
              },
              (e: unknown) => {
                notify.warning(t('form.variants_failed'), {
                  description: isApiError(e) ? e.message : undefined,
                })
              },
            ),
          )
      }
      await Promise.all(followUps)
      await invalidateRoutes(queryClient, [catalogRoutes.listProducts, catalogRoutes.getProduct])
      form.reset(values)
      leaving.current = true
      notify.success(t('form.created', { name: created.name }))
      if (afterSave.current === 'new') {
        void navigate('/catalog/products/new', { replace: true, state: { again: newId() } })
      } else {
        void navigate(`/catalog/products/${created.id}`, { replace: true })
      }
    } catch {
      // handled in onError
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault()
    if (readOnly) return
    void form.handleSubmit(save, () => {
      notify.error(t('form.fix_errors'))
    })(e)
  }

  useHotkeys(
    {
      'mod+s': () => {
        if (readOnly) return
        afterSave.current = 'open'
        formRef.current?.requestSubmit()
      },
    },
    { allowInInputs: true },
  )

  const sections = [
    { id: 'basic', label: t('form.sections.basic') },
    { id: 'pricing', label: t('form.sections.pricing') },
    { id: 'tax', label: t('form.sections.tax') },
    { id: 'units', label: t('form.sections.units') },
    { id: 'inventory', label: t('form.sections.inventory') },
    ...(kind !== 'variant_parent' ? [{ id: 'barcodes', label: t('form.sections.barcodes') }] : []),
    ...(ATTRIBUTE_FIELDS[businessType].length
      ? [{ id: 'attributes', label: t('form.sections.attributes_short') }]
      : []),
    ...(hasVariants &&
    (kind === 'variant_parent' ||
      (mode === 'edit' &&
        kind === 'standard' &&
        (businessType === 'apparel' || businessType === 'footwear')))
      ? [{ id: 'variants', label: t('form.sections.variants') }]
      : []),
  ]
  const dirty = form.formState.isDirty && !readOnly

  return (
    <ProductFormEnvContext.Provider value={env}>
      <FormProvider {...form}>
        <UnsavedChangesGuard when={dirty && !saving} allowRef={leaving} />
        <nav
          aria-label={t('form.sections_nav')}
          className="sticky top-16 z-10 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-border bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
        >
          {sections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={(e) => {
                e.preventDefault()
                document
                  .getElementById(s.id)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className="shrink-0 rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              {s.label}
            </a>
          ))}
        </nav>
        <form
          ref={formRef}
          id={FORM_ID}
          onSubmit={onSubmit}
          noValidate
          className="mx-auto grid grid-cols-1 max-w-5xl gap-4"
        >
          <fieldset disabled={readOnly} className="contents">
            <BasicSection icon={<Package />} />
            <PricingSection icon={<IndianRupee />} />
            <TaxSection icon={<Percent />} />
            <UnitsSection icon={<Ruler />} />
            <InventorySection icon={<Boxes />} />
            {kind !== 'variant_parent' ? <BarcodesSection icon={<Barcode />} /> : null}
            <AttributesSection icon={<FileText />} />
          </fieldset>
          {hasVariants && kind === 'variant_parent' && mode === 'create' ? (
            <Section
              id="variants"
              icon={<Layers />}
              title={t('form.sections.variants')}
              description={t('variants.create_hint')}
            >
              <VariantMatrixEditor
                draft={variantDraft}
                onChange={setVariantDraft}
                existingAxes={[]}
                existing={[]}
              />
            </Section>
          ) : null}
        </form>
        {hasVariants &&
        mode === 'edit' &&
        product &&
        (kind === 'variant_parent' ||
          (kind === 'standard' && (businessType === 'apparel' || businessType === 'footwear'))) ? (
          <div className="mx-auto mt-4 max-w-5xl">
            <VariantsSection icon={<Tag />} />
          </div>
        ) : null}
        {!readOnly ? (
          <SaveBar
            formId={FORM_ID}
            dirty={dirty}
            saving={saving}
            onDiscard={() => form.reset(baseline.current)}
            onSaveClick={() => {
              afterSave.current = 'open'
            }}
            saveLabel={mode === 'create' ? t('form.create') : t('common:actions.save_changes')}
            status={mode === 'edit' ? t('form.all_saved') : undefined}
            extra={
              mode === 'create' ? (
                <Button
                  type="submit"
                  form={FORM_ID}
                  variant="outline"
                  size="lg"
                  className="hidden sm:inline-flex"
                  onClick={() => {
                    afterSave.current = 'new'
                  }}
                  disabled={saving}
                >
                  {t('form.save_and_new')}
                </Button>
              ) : null
            }
          />
        ) : null}
      </FormProvider>
    </ProductFormEnvContext.Provider>
  )
}
