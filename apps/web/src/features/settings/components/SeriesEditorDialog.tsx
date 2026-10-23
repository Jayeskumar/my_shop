/**
 * Edit one number series: prefix, zero padding and the next number, with a live example of the
 * next document number and its length against the GST limit (16 characters for tax documents).
 * A series not used yet this year is created (POST) with the chosen values — e.g. to continue the
 * numbering of the old billing software. The next number never goes down, and changing the
 * prefix after documents were issued needs an explicit confirmation (audited).
 */
import { CircleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DOC_TYPE_LABELS,
  formatSeriesNumber,
  seriesFormatIssues,
  type NumberSeries,
} from '@kadai/shared/api/identity'
import { Button, Checkbox, Dialog, FormField, Input, NumberInput, notify } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getLanguage } from '@/lib/i18n'
import { useCreateNumberSeries, useUpdateNumberSeries } from '../api'
import { errorReason, notifySettingsError, reasonText, useValidationKeyText } from '../lib/messages'

export function SeriesEditorDialog({
  open,
  onOpenChange,
  series,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  series: NumberSeries | null
}) {
  const { t } = useTranslation(['settings', 'common'])
  const keyText = useValidationKeyText()
  const create = useCreateNumberSeries()
  const update = useUpdateNumberSeries()
  const [prefix, setPrefix] = useState('')
  // null while the field is empty (being retyped).
  const [padding, setPadding] = useState<number | null>(5)
  const [next, setNext] = useState<number | null>(1)
  const [force, setForce] = useState(false)
  const [needsForce, setNeedsForce] = useState(false)
  const [serverError, setServerError] = useState<{ field: 'prefix' | 'next'; text: string } | null>(
    null,
  )
  const saving = create.isPending || update.isPending

  useEffect(() => {
    if (!open || !series) return
    setPrefix(series.prefix)
    setPadding(series.padding)
    setNext(series.next_number)
    setForce(false)
    setNeedsForce(false)
    setServerError(null)
  }, [open, series])

  if (!series) return null
  const lng = getLanguage()
  const nextValue = next ?? series.next_number
  const paddingValue = padding ?? series.padding
  const sample = formatSeriesNumber(prefix, nextValue, paddingValue)
  const issues = seriesFormatIssues({
    doc_type: series.doc_type,
    prefix,
    padding: paddingValue,
    next_number: nextValue,
  })
  const prefixIssue = issues.find((i) => i.path === 'prefix')
  const decreasing = series.id !== null && next !== null && next < series.next_number
  const prefixChanged = prefix !== series.prefix
  const mustForce = series.id !== null && series.issued_count > 0 && prefixChanged
  const tooLong = sample.length > series.max_length
  const blocked =
    Boolean(prefixIssue) ||
    decreasing ||
    (mustForce && !force) ||
    next === null ||
    next < 1 ||
    padding === null

  const save = async (): Promise<void> => {
    if (blocked || next === null || padding === null) return
    setServerError(null)
    try {
      if (series.id === null) {
        await create.mutateAsync({
          body: {
            store_id: series.store_id,
            register_id: series.register_id,
            doc_type: series.doc_type,
            fy: series.fy,
            prefix,
            padding,
            next_number: next,
          },
        })
      } else {
        await update.mutateAsync({
          params: { id: series.id },
          body: {
            ...(prefixChanged ? { prefix } : {}),
            ...(padding !== series.padding ? { padding } : {}),
            ...(next !== series.next_number ? { next_number: next } : {}),
            ...(mustForce ? { force: true } : {}),
            ...(series.updated_at ? { if_updated_at: series.updated_at } : {}),
          },
        })
      }
      notify.success(t('series.saved', { number: sample }))
      onOpenChange(false)
    } catch (error) {
      const reason = errorReason(error)
      if (reason === 'series_in_use') {
        setNeedsForce(true)
        return
      }
      if (reason === 'prefix_in_use') {
        setServerError({ field: 'prefix', text: reasonText(error) ?? reason })
        return
      }
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const issue = error.validationIssues[0]
        if (issue) {
          setServerError({
            field: issue.path === 'next_number' ? 'next' : 'prefix',
            text: keyText(issue.message) ?? issue.message,
          })
          return
        }
      }
      if (isApiError(error) && error.code === 'STALE_WRITE') {
        notify.error(t('common.stale_write'))
        onOpenChange(false)
        return
      }
      notifySettingsError(error)
    }
  }

  const prefixError =
    serverError?.field === 'prefix'
      ? serverError.text
      : prefixIssue && prefixIssue.code === 'series_prefix_chars'
        ? keyText(prefixIssue.code)
        : undefined
  const nextError =
    serverError?.field === 'next'
      ? serverError.text
      : decreasing
        ? keyText('next_number_decrease')
        : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !saving && onOpenChange(o)}
      title={t('series.edit_title', {
        doc: DOC_TYPE_LABELS[series.doc_type][lng],
        store: series.store_code,
      })}
      description={
        series.register_code
          ? t('series.edit_register', { register: series.register_code, fy: series.fy })
          : t('series.edit_store', { fy: series.fy })
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={blocked}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div
          className={cn(
            'rounded-xl border px-4 py-3',
            tooLong ? 'border-danger/40 bg-danger-soft' : 'border-primary/30 bg-primary-soft',
          )}
          aria-live="polite"
        >
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('series.next_document')}
          </div>
          <div className="mt-1 break-all font-mono text-2xl font-semibold tracking-wide">
            {sample}
          </div>
          <div
            className={cn(
              'mt-1 text-xs',
              tooLong ? 'font-medium text-danger' : 'text-muted-foreground',
            )}
          >
            {t('series.length', { count: sample.length, max: series.max_length })}
            {series.is_gst_document ? ` · ${t('series.gst_limit')}` : ''}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem] [&>*]:min-w-0">
          <FormField label={t('series.prefix')} hint={t('series.prefix_hint')} error={prefixError}>
            <Input
              value={prefix}
              onChange={(e) => {
                setPrefix(e.target.value.toUpperCase().replace(/\s/g, ''))
                setServerError(null)
              }}
              maxLength={28}
              className="font-mono uppercase tracking-wide"
              autoFocus
            />
          </FormField>
          <FormField label={t('series.padding')} hint={t('series.padding_hint')}>
            <NumberInput
              value={padding}
              onChange={(v) => setPadding(v === null ? null : Math.min(10, Math.max(1, v)))}
              min={1}
              max={10}
              className="tabular-nums"
            />
          </FormField>
        </div>
        <FormField
          label={t('series.next_number')}
          hint={
            series.id === null
              ? t('series.next_number_new_hint')
              : t('series.next_number_hint', { count: series.issued_count })
          }
          error={nextError}
        >
          <NumberInput
            value={next}
            onChange={(v) => {
              setNext(v)
              setServerError(null)
            }}
            min={1}
            max={9_999_999_999}
            className="max-w-48 tabular-nums"
          />
        </FormField>
        {tooLong ? (
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('series.too_long', { max: series.max_length })}
          </p>
        ) : null}
        {mustForce || needsForce ? (
          <div className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning-soft-foreground">
            <p className="mb-2">{t('series.force_warning', { count: series.issued_count })}</p>
            <Checkbox
              checked={force}
              onCheckedChange={(v) => setForce(v === true)}
              label={t('series.force_confirm')}
            />
          </div>
        ) : null}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          {t('common:actions.save')}
        </button>
      </form>
    </Dialog>
  )
}
