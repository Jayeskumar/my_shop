/**
 * Barcodes: scan or type to add (Enter — keyboard-wedge scanners send it), case barcodes with a
 * quantity, generate an internal EAN-13, remove, and print a label. New products keep drafts in
 * the form (sent with POST /products); saved products change immediately
 * (POST/DELETE /products/:id/barcodes).
 */
import {
  type ProductBarcode,
  barcodeIssue,
  catalogRoutes,
  isInternalCode,
} from '@kadai/shared/api/catalog'
import { Barcode, Printer, ScanBarcode, Sparkles, Trash2 } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import { Controller, useFieldArray } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  IconButton,
  Input,
  Qty,
  QtyInput,
  Switch,
  useConfirm,
  notify,
} from '@/components/ui'
import { useFeature } from '@/lib/auth'
import { formatDate } from '@/lib/format'
import { useRouteMutation } from '@/lib/query'
import { Section } from '../components/FormChrome'
import { LinkButton } from '../components/LinkButton'
import { catalogReasonText, catalogValidationText, firstIssueText } from '../lib/messages'
import { useProductForm, useProductFormEnv } from './env'

export function BarcodesSection({ icon }: { icon: ReactNode }) {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const hasLabels = useFeature('barcode_labels')
  const product = env.product
  return (
    <Section
      id="barcodes"
      icon={icon}
      title={t('form.sections.barcodes')}
      description={t('form.sections.barcodes_hint')}
      actions={
        env.mode === 'edit' && product && hasLabels && product.kind !== 'variant_parent' ? (
          <LinkButton
            to={`/catalog/labels?product_ids=${product.id}`}
            variant="outline"
            size="sm"
            icon={<Printer />}
          >
            {t('barcodes.print_label')}
          </LinkButton>
        ) : null
      }
    >
      {env.mode === 'create' ? <DraftBarcodes /> : <SavedBarcodes />}
    </Section>
  )
}

function useCodeEntry(onAdd: (code: string, qtyMilli: number) => boolean | Promise<boolean>) {
  const [code, setCode] = useState('')
  const [qty, setQty] = useState<number | null>(1000)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    const value = code.trim()
    if (!value) return
    const issue = barcodeIssue(value)
    if (issue) {
      setError(catalogValidationText(issue) ?? issue)
      return
    }
    setError(null)
    if (await onAdd(value, qty && qty > 0 ? qty : 1000)) {
      setCode('')
      setQty(1000)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }
  return { code, setCode, qty, setQty, error, setError, submit, onKeyDown }
}

function CodeEntry({
  entry,
  unit,
  busy,
  disabled,
}: {
  entry: ReturnType<typeof useCodeEntry>
  unit: string
  busy?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('catalog')
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="grid grid-cols-1 flex-1 gap-1.5 text-sm font-medium">
          {t('barcodes.scan_label')}
          <Input
            value={entry.code}
            onChange={(e) => {
              entry.setCode(e.target.value)
              entry.setError(null)
            }}
            onKeyDown={entry.onKeyDown}
            placeholder={t('barcodes.scan_placeholder')}
            startAdornment={<ScanBarcode />}
            className="font-mono"
            inputMode="text"
            autoComplete="off"
            disabled={disabled}
            aria-invalid={entry.error ? true : undefined}
          />
        </label>
        <label className="grid grid-cols-1 gap-1.5 text-sm font-medium sm:w-52">
          {t('barcodes.qty_label')}
          <QtyInput
            value={entry.qty}
            onChange={entry.setQty}
            unit={unit}
            min={1000}
            steppers={false}
            disabled={disabled}
          />
        </label>
        <Button
          variant="secondary"
          onClick={() => void entry.submit()}
          loading={busy}
          disabled={disabled || !entry.code.trim()}
        >
          {t('barcodes.add')}
        </Button>
      </div>
      {entry.error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {entry.error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('barcodes.case_hint')}</p>
      )}
    </div>
  )
}

function DraftBarcodes() {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const { control, watch } = useProductForm()
  const unit = watch('unit')
  const drafts = useFieldArray({ control, name: 'barcodes' })
  const entry = useCodeEntry((code, qty) => {
    if (drafts.fields.some((f) => f.barcode === code)) {
      entry.setError(t('barcodes.duplicate'))
      return false
    }
    drafts.append({ barcode: code, qty_milli: qty })
    return true
  })
  return (
    <div className="grid grid-cols-1 gap-4">
      {!env.readOnly ? <CodeEntry entry={entry} unit={unit} /> : null}
      {drafts.fields.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {drafts.fields.map((f, i) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2">
              <Barcode className="size-4 text-muted-foreground" aria-hidden />
              <span className="flex-1 font-mono">{f.barcode}</span>
              {f.qty_milli !== 1000 ? (
                <Badge tone="info" size="sm">
                  <Qty milli={f.qty_milli} unit={unit} />
                </Badge>
              ) : null}
              <IconButton
                icon={<Trash2 />}
                label={t('barcodes.remove', { code: f.barcode })}
                variant="ghost"
                size="sm"
                onClick={() => drafts.remove(i)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Controller
          control={control}
          name="generate_barcode"
          render={({ field }) => (
            <Switch
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={env.readOnly}
              label={t('barcodes.generate_on_save')}
              description={t('barcodes.generate_hint')}
            />
          )}
        />
      )}
    </div>
  )
}

function SavedBarcodes() {
  const { t } = useTranslation('catalog')
  const env = useProductFormEnv()
  const confirm = useConfirm()
  const product = env.product!
  const add = useRouteMutation(catalogRoutes.addBarcode, {
    invalidates: [catalogRoutes.getProduct, catalogRoutes.listProducts],
    onError: (error) => {
      const text = catalogReasonText(error) ?? firstIssueText(error)
      if (text) entry.setError(text)
      else notify.error(error)
    },
  })
  const remove = useRouteMutation(catalogRoutes.deleteBarcode, {
    invalidates: [catalogRoutes.getProduct, catalogRoutes.listProducts],
  })
  const entry = useCodeEntry(async (code, qty) => {
    try {
      await add.mutateAsync({ params: { id: product.id }, body: { barcode: code, qty_milli: qty } })
      notify.success(t('barcodes.added', { code }))
      return true
    } catch {
      return false
    }
  })
  const generate = (): void =>
    add.mutate(
      { params: { id: product.id }, body: { generate: true } },
      { onSuccess: (res) => notify.success(t('barcodes.generated', { code: res.data.barcode })) },
    )
  const del = async (b: ProductBarcode): Promise<void> => {
    const ok = await confirm({
      title: t('barcodes.remove_title', { code: b.barcode }),
      description: t('barcodes.remove_description'),
      tone: 'danger',
      confirmLabel: t('barcodes.remove_confirm'),
    })
    if (!ok) return
    remove.mutate(
      { params: { id: product.id, barcodeId: b.id } },
      { onSuccess: () => notify.success(t('barcodes.removed', { code: b.barcode })) },
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {product.barcodes.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {product.barcodes.map((b, i) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <Barcode className="size-4 text-muted-foreground" aria-hidden />
              <span className="font-mono text-base">{b.barcode}</span>
              {i === 0 ? (
                <Badge tone="primary" size="sm">
                  {t('barcodes.primary')}
                </Badge>
              ) : null}
              {b.is_internal || isInternalCode(b.barcode) ? (
                <Badge tone="neutral" size="sm">
                  {t('barcodes.internal')}
                </Badge>
              ) : null}
              {b.qty_milli !== 1000 ? (
                <Badge tone="info" size="sm">
                  {t('barcodes.case_of')} <Qty milli={b.qty_milli} unit={product.unit} />
                </Badge>
              ) : null}
              <span className="ms-auto text-xs text-muted-foreground">
                {formatDate(b.created_at)}
              </span>
              {!env.readOnly ? (
                <IconButton
                  icon={<Trash2 />}
                  label={t('barcodes.remove', { code: b.barcode })}
                  variant="ghost"
                  size="sm"
                  onClick={() => void del(b)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t('barcodes.none')}
        </p>
      )}
      {!env.readOnly ? (
        <>
          <CodeEntry entry={entry} unit={product.unit} busy={add.isPending} />
          <div>
            <Button
              variant="outline"
              leftIcon={<Sparkles />}
              onClick={generate}
              loading={add.isPending}
            >
              {t('barcodes.generate')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
