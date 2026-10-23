/** Basic details: names, Tanglish search words, category (fills tax defaults), brand, photo. */
import { type Brand, type Category, catalogRoutes } from '@kadai/shared/api/catalog'
import { FILE_UPLOAD_RULES } from '@kadai/shared/api/identity'
import { formatBp } from '@kadai/shared/money'
import { ImagePlus, Info, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Controller } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { BrandPicker, CategoryPicker } from '@/components/pickers'
import { Button, Input, Spinner, Switch, notify } from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { ChipsInput } from '../components/ChipsInput'
import { Field } from '../components/Field'
import { ProductThumb } from '../components/ProductThumb'
import { Section } from '../components/FormChrome'
import { uploadFile, uploadIssue } from '../lib/files'
import { categoryTaxDefaults } from '../lib/product-form'
import { useProductForm, useProductFormEnv } from './env'

/** Verticals with their own example product names (others use the grocery example). */
const NAME_EXAMPLE_VERTICALS = [
  'pharmacy',
  'apparel',
  'footwear',
  'electronics',
  'hardware',
  'bakery_sweets',
  'stationery',
] as const

export function BasicSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const form = useProductForm()
  const { register, control, setValue, getFieldState, watch } = form
  const kind = watch('kind')
  const [taxHint, setTaxHint] = useState<string | null>(null)
  const flat = useRouteQuery(
    catalogRoutes.listCategories,
    { query: { flat: true, is_active: true } },
    { staleTime: 5 * 60_000 },
  )
  const createBrand = useRouteMutation(catalogRoutes.createBrand, {
    invalidates: [catalogRoutes.listBrands],
  })

  const applyCategoryDefaults = (categoryId: string | null, category: Category | null): void => {
    if (env.mode !== 'create' || !categoryId) return
    const d = categoryTaxDefaults((flat.data?.data ?? []) as Category[], categoryId)
    const applied: string[] = []
    if (d.hsn_code && !getFieldState('hsn_code').isDirty) {
      setValue('hsn_code', d.hsn_code)
      applied.push(`HSN ${d.hsn_code}`)
    }
    if (d.gst_rate_bp !== null && !getFieldState('gst_rate_bp').isDirty) {
      setValue('gst_rate_bp', d.gst_rate_bp)
      applied.push(`GST ${formatBp(d.gst_rate_bp)}`)
    }
    if (d.tax_slab_rule_id && !getFieldState('tax_slab_rule_id').isDirty) {
      setValue('tax_slab_rule_id', d.tax_slab_rule_id)
      applied.push(t('tax.slab_rule'))
    }
    setTaxHint(
      applied.length && category
        ? t('basic.category_defaults', { category: category.name, items: applied.join(', ') })
        : null,
    )
  }

  const variantVertical = env.businessType === 'apparel' || env.businessType === 'footwear'
  const examples = NAME_EXAMPLE_VERTICALS.find((b) => b === env.businessType)
  const namePlaceholder = examples
    ? t(`basic.name_examples.${examples}`)
    : t('basic.name_placeholder')
  const nameTaPlaceholder = examples
    ? t(`basic.name_ta_examples.${examples}`)
    : t('basic.name_ta_placeholder')

  return (
    <Section
      id="basic"
      icon={icon}
      title={t('form.sections.basic')}
      description={t('form.sections.basic_hint')}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="name" label={t('fields.name')} required>
              <Input
                {...register('name')}
                autoFocus={env.mode === 'create'}
                placeholder={namePlaceholder}
                maxLength={200}
              />
            </Field>
            <Field
              name="name_ta"
              label={t('fields.name_ta')}
              optional
              hint={t('basic.name_ta_hint')}
            >
              <Input
                {...register('name_ta')}
                lang="ta"
                placeholder={nameTaPlaceholder}
                maxLength={200}
              />
            </Field>
          </div>
          <Field name="aliases" label={t('fields.aliases')} optional hint={t('basic.aliases_hint')}>
            <Controller
              control={control}
              name="aliases"
              render={({ field }) => (
                <ChipsInput
                  value={field.value}
                  onChange={field.onChange}
                  max={20}
                  placeholder={t('basic.aliases_placeholder')}
                  disabled={env.readOnly}
                />
              )}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              name="category_id"
              label={t('fields.category')}
              optional
              hint={taxHint ?? undefined}
            >
              <Controller
                control={control}
                name="category_id"
                render={({ field }) => (
                  <CategoryPicker
                    value={field.value}
                    disabled={env.readOnly}
                    onChange={(id, c) => {
                      field.onChange(id)
                      applyCategoryDefaults(id, c)
                    }}
                  />
                )}
              />
            </Field>
            <Field name="brand" label={t('fields.brand')} optional>
              <Controller
                control={control}
                name="brand"
                render={({ field }) => (
                  <BrandPicker
                    value={field.value}
                    disabled={env.readOnly}
                    onChange={(b: Brand | null) =>
                      field.onChange(b ? { id: b.id, name: b.name } : null)
                    }
                    onCreate={
                      env.readOnly
                        ? undefined
                        : (name) =>
                            createBrand.mutate(
                              { body: { name } },
                              {
                                onSuccess: (res) => {
                                  field.onChange({ id: res.data.id, name: res.data.name })
                                  notify.success(t('brands.created', { name: res.data.name }))
                                },
                              },
                            )
                    }
                  />
                )}
              />
            </Field>
          </div>
          <Field name="description" label={t('fields.description')} optional>
            <Textarea {...register('description')} rows={2} maxLength={2000} />
          </Field>
          {env.mode === 'create' || kind === 'standard' || kind === 'service' ? (
            <div className="grid grid-cols-1 gap-3 rounded-lg bg-surface-2 p-3 sm:grid-cols-2">
              <Switch
                checked={kind === 'service'}
                disabled={env.readOnly || kind === 'variant_parent'}
                onCheckedChange={(v) =>
                  setValue('kind', v ? 'service' : 'standard', {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
                label={t('basic.is_service')}
                description={t('basic.is_service_hint')}
              />
              {env.mode === 'create' &&
              env.hasVariantsFeature &&
              (variantVertical || kind === 'variant_parent') ? (
                <Switch
                  checked={kind === 'variant_parent'}
                  disabled={env.readOnly}
                  onCheckedChange={(v) =>
                    setValue('kind', v ? 'variant_parent' : 'standard', { shouldDirty: true })
                  }
                  label={t('basic.has_variants')}
                  description={t('basic.has_variants_hint')}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <PhotoField />
      </div>
    </Section>
  )
}

function PhotoField() {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { setValue, watch, getValues } = useProductForm()
  const imageId = watch('image_file_id')
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview)
    },
    [preview],
  )

  const pick = async (file: File): Promise<void> => {
    const issue = uploadIssue('product_image', file)
    if (issue) {
      notify.error(
        t(`files.${issue}`, { max: FILE_UPLOAD_RULES.product_image.max_bytes / 1024 / 1024 }),
      )
      return
    }
    setUploading(true)
    try {
      const meta = await uploadFile(file, 'product_image')
      if (typeof URL.createObjectURL === 'function') setPreview(URL.createObjectURL(file))
      setValue('image_file_id', meta.id, { shouldDirty: true })
    } catch (error) {
      notify.error(error)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-row items-center gap-3 md:flex-col md:items-stretch">
      <div className="relative">
        <ProductThumb
          fileId={imageId}
          previewUrl={imageId ? preview : null}
          name={imageId ? getValues('name') : ''}
          size="xl"
        />
        {uploading ? (
          <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-surface/70">
            <Spinner label={t('basic.uploading')} />
          </span>
        ) : null}
      </div>
      {!env.readOnly ? (
        <div className="flex flex-col gap-1.5">
          <input
            ref={input}
            type="file"
            accept={FILE_UPLOAD_RULES.product_image.accept}
            className="sr-only"
            aria-label={t('basic.photo')}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void pick(file)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            leftIcon={<ImagePlus />}
            onClick={() => input.current?.click()}
            disabled={uploading}
          >
            {imageId ? t('basic.change_photo') : t('basic.add_photo')}
          </Button>
          {imageId ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Trash2 />}
              onClick={() => {
                setPreview(null)
                setValue('image_file_id', null, { shouldDirty: true })
              }}
            >
              {t('basic.remove_photo')}
            </Button>
          ) : (
            <p className="flex max-w-40 items-start gap-1 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" />
              {t('basic.photo_hint')}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}
