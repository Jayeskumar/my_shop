/**
 * Manual journal voucher (POST /journal-entries): date, narration and two or more lines — each an
 * account with a debit OR a credit (typing one side clears the other), a customer / supplier for
 * receivable / payable accounts, and an optional line note. The live balance bar shows Σ debit,
 * Σ credit and the difference (journalTotals, the same check the server makes); "Add line"
 * pre-fills the amount that balances the entry. Saved with a JV number and audited.
 */
import { Plus, Scale, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  Controller,
  FormProvider,
  type Resolver,
  useFieldArray,
  useForm,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { PartyType } from '@kadai/shared'
import {
  type AccountSubtype,
  type JournalEntryDetail,
  MANUAL_JOURNAL_MAX_LINES,
  type ManualJournalCreate,
  ManualJournalCreateSchema,
  journalTotals,
} from '@kadai/shared/api/accounting'
import { newId } from '@kadai/shared/ids'
import { AccountPicker, CustomerPicker, StorePicker, SupplierPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DatePicker,
  Dialog,
  IconButton,
  Input,
  MoneyInput,
  notify,
} from '@/components/ui'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useCurrentStore } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { formatMoney } from '@/lib/format'
import { useHotkeys } from '@/lib/hotkeys'
import { useCreateJournalEntry } from '../api'
import { notifyAccountingError, validationText } from '../lib/errors'
import { contractResolver, textOrNull } from '../lib/forms'
import { useTenantInfo } from '../lib/tenant'
import { AccountingField } from './AccountingField'

interface LineForm {
  key: string
  account_id: string | null
  account_subtype: AccountSubtype | null
  debit_paise: number | null
  credit_paise: number | null
  party: { type: PartyType; id: string; name: string } | null
  memo: string
}

interface JournalForm {
  entry_date: string
  store_id: string | null
  narration: string
  lines: LineForm[]
}

const emptyLine = (patch: Partial<LineForm> = {}): LineForm => ({
  key: newId(),
  account_id: null,
  account_subtype: null,
  debit_paise: null,
  credit_paise: null,
  party: null,
  memo: '',
  ...patch,
})

const isBlank = (l: LineForm): boolean => !l.account_id && !l.debit_paise && !l.credit_paise

/** Body issue path → form path ('lines.N.x' → the N-th sent line's form row). */
function journalFormPath(path: string, keptIdx: readonly number[]): string {
  if (path === 'lines' || path === 'client_ref') return 'root'
  const m = /^lines\.(\d+)\.([a-z_]+)/.exec(path)
  if (m) {
    const formIndex = keptIdx[Number(m[1])]
    const field = m[2] === 'party_id' || m[2] === 'party_type' ? 'party' : m[2]
    return formIndex === undefined ? 'root' : `lines.${formIndex}.${field}`
  }
  return path.split('.')[0] ?? 'root'
}

/** Party type a system subtype needs on its lines (receivable → customer, payable → supplier). */
function partyTypeFor(subtype: AccountSubtype | null): PartyType | null {
  if (subtype === 'receivable') return 'customer'
  if (subtype === 'payable') return 'supplier'
  return null
}

export function ManualJournalDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (entry: JournalEntryDetail) => void
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const currentStore = useCurrentStore()
  const mutation = useCreateJournalEntry()
  const [clientRef, setClientRef] = useState(() => newId())

  const defaults = useMemo<JournalForm>(
    () => ({
      entry_date: tenant.today,
      store_id: currentStore?.id ?? tenant.stores[0]?.id ?? null,
      narration: '',
      lines: [emptyLine(), emptyLine()],
    }),
    [tenant.today, tenant.stores, currentStore],
  )

  /** Form lines that are sent (blank extra lines are skipped) with their form indexes. */
  const kept = (lines: LineForm[]): number[] => {
    const idx = lines.map((l, i) => (isBlank(l) ? -1 : i)).filter((i) => i >= 0)
    return idx.length >= 2 ? idx : lines.map((_, i) => i)
  }

  const toBody = (v: JournalForm): ManualJournalCreate => ({
    entry_date: v.entry_date,
    ...(tenant.multiStore && v.store_id ? { store_id: v.store_id } : {}),
    narration: v.narration.trim(),
    lines: kept(v.lines).map((i) => {
      const l = v.lines[i]!
      return {
        account_id: l.account_id ?? '',
        debit_paise: l.debit_paise ?? 0,
        credit_paise: l.credit_paise ?? 0,
        ...(l.party ? { party_type: l.party.type, party_id: l.party.id } : {}),
        memo: textOrNull(l.memo),
      }
    }),
    client_ref: clientRef,
  })

  const resolver: Resolver<JournalForm> = (values, context, options) => {
    const keptIdx = kept(values.lines)
    return contractResolver<JournalForm>(ManualJournalCreateSchema, toBody, (path) =>
      journalFormPath(path, keptIdx),
    )(values, context, options)
  }
  const form = useForm<JournalForm>({ defaultValues: defaults, resolver })
  const { control, handleSubmit, reset, setValue, setError, getValues, formState } = form
  const lines = useFieldArray({ control, name: 'lines', keyName: 'key' })

  useEffect(() => {
    if (!open) return
    reset(defaults)
    setClientRef(newId())
  }, [open, defaults, reset])

  const watched = useWatch({ control, name: 'lines' })
  const totals = journalTotals(
    (watched ?? []).map((l) => ({
      debit_paise: l?.debit_paise ?? 0,
      credit_paise: l?.credit_paise ?? 0,
    })),
  )

  const save = (values: JournalForm): void => {
    mutation.mutate(
      { body: toBody(values), idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          notify.success(t('journal.form.saved', { number: res.data.number ?? '' }))
          onSaved?.(res.data)
          onOpenChange(false)
        },
        onError: (error) => {
          if (applyServerFieldErrors(error, setError, ['entry_date', 'narration', 'store_id']))
            return
          notifyAccountingError(error)
        },
      },
    )
  }
  const submit = () => void handleSubmit(save)()

  useHotkeys(
    { 'ctrl+s, mod+enter': submit },
    { scope: 'dialog', allowInInputs: true, enabled: open },
  )

  const addLine = (): void => {
    const d = totals.difference_paise
    lines.append(emptyLine(d > 0 ? { credit_paise: d } : d < 0 ? { debit_paise: -d } : {}), {
      shouldFocus: false,
    })
  }

  const rootError = validationText(formState.errors.root?.message)
  const empty = totals.debit_paise === 0 && totals.credit_paise === 0

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('journal.form.title')}
      description={t('journal.form.description')}
      size="xl"
      dismissible={false}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form="journal-form" size="lg" loading={mutation.isPending}>
            {t('journal.form.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="journal-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex flex-col gap-4"
        >
          <div
            className={cn(
              'grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]',
              tenant.multiStore && 'lg:grid-cols-[10rem_14rem_minmax(0,1fr)]',
            )}
          >
            <AccountingField name="entry_date" label={t('common:fields.date')} required>
              <Controller
                control={control}
                name="entry_date"
                render={({ field }) => (
                  <DatePicker
                    value={field.value}
                    onChange={(d) => field.onChange(d ?? '')}
                    max={tenant.today}
                  />
                )}
              />
            </AccountingField>
            {tenant.multiStore ? (
              <AccountingField name="store_id" label={t('common:fields.store')}>
                <Controller
                  control={control}
                  name="store_id"
                  render={({ field }) => (
                    <StorePicker
                      value={field.value}
                      onChange={(id) => field.onChange(id)}
                      clearable={false}
                    />
                  )}
                />
              </AccountingField>
            ) : null}
            <AccountingField
              name="narration"
              label={t('journal.fields.narration')}
              required
              className={tenant.multiStore ? 'sm:col-span-2 lg:col-span-1' : undefined}
            >
              <Input
                {...form.register('narration')}
                maxLength={500}
                placeholder={t('journal.form.narration_placeholder')}
              />
            </AccountingField>
          </div>

          <div className="flex flex-col gap-2" role="group" aria-label={t('journal.form.lines')}>
            <div className="hidden grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_2.5rem] gap-2 px-1 text-xs font-medium text-muted-foreground md:grid">
              <span>{t('journal.fields.account')}</span>
              <span className="text-end">{t('journal.fields.debit')}</span>
              <span className="text-end">{t('journal.fields.credit')}</span>
              <span />
            </div>
            {lines.fields.map((line, index) => {
              const partyType = partyTypeFor(watched?.[index]?.account_subtype ?? null)
              return (
                <div
                  key={line.key}
                  className="grid gap-2 rounded-lg border border-border p-2 md:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem_2.5rem] md:border-0 md:p-1"
                  data-testid={`journal-line-${index}`}
                >
                  <AccountingField
                    name={`lines.${index}.account_id`}
                    hideLabel
                    label={t('journal.fields.account_n', { n: index + 1 })}
                  >
                    <Controller
                      control={control}
                      name={`lines.${index}.account_id`}
                      render={({ field }) => (
                        <AccountPicker
                          value={field.value}
                          onChange={(id, account) => {
                            field.onChange(id)
                            setValue(`lines.${index}.account_subtype`, account?.subtype ?? null)
                            if (
                              partyTypeFor(account?.subtype ?? null) !==
                              getValues(`lines.${index}.party`)?.type
                            ) {
                              setValue(`lines.${index}.party`, null)
                            }
                          }}
                          aria-label={t('journal.fields.account_n', { n: index + 1 })}
                        />
                      )}
                    />
                  </AccountingField>
                  <div className="grid grid-cols-2 gap-2 md:contents">
                    <AccountingField
                      name={`lines.${index}.debit_paise`}
                      hideLabel
                      label={t('journal.fields.debit_n', { n: index + 1 })}
                    >
                      <Controller
                        control={control}
                        name={`lines.${index}.debit_paise`}
                        render={({ field }) => (
                          <MoneyInput
                            value={field.value}
                            onChange={(p) => {
                              field.onChange(p)
                              if (p) setValue(`lines.${index}.credit_paise`, null)
                            }}
                            placeholder={t('journal.fields.debit')}
                            aria-label={t('journal.fields.debit_n', { n: index + 1 })}
                            className="text-end"
                          />
                        )}
                      />
                    </AccountingField>
                    <AccountingField
                      name={`lines.${index}.credit_paise`}
                      hideLabel
                      label={t('journal.fields.credit_n', { n: index + 1 })}
                    >
                      <Controller
                        control={control}
                        name={`lines.${index}.credit_paise`}
                        render={({ field }) => (
                          <MoneyInput
                            value={field.value}
                            onChange={(p) => {
                              field.onChange(p)
                              if (p) setValue(`lines.${index}.debit_paise`, null)
                            }}
                            placeholder={t('journal.fields.credit')}
                            aria-label={t('journal.fields.credit_n', { n: index + 1 })}
                            className="text-end"
                          />
                        )}
                      />
                    </AccountingField>
                  </div>
                  <IconButton
                    icon={<Trash2 />}
                    label={t('journal.form.remove_line', { n: index + 1 })}
                    variant="ghost"
                    disabled={lines.fields.length <= 2}
                    onClick={() => lines.remove(index)}
                    className="justify-self-end md:row-span-1"
                  />
                  <div className="grid gap-2 sm:grid-cols-2 md:col-span-3">
                    {partyType ? (
                      <AccountingField
                        name={`lines.${index}.party`}
                        hideLabel
                        label={t(
                          partyType === 'customer'
                            ? 'journal.fields.customer'
                            : 'journal.fields.supplier',
                        )}
                      >
                        <Controller
                          control={control}
                          name={`lines.${index}.party`}
                          render={({ field }) =>
                            partyType === 'customer' ? (
                              <CustomerPicker
                                value={
                                  field.value
                                    ? { id: field.value.id, name: field.value.name }
                                    : null
                                }
                                onChange={(c) =>
                                  field.onChange(
                                    c ? { type: 'customer', id: c.id, name: c.name } : null,
                                  )
                                }
                                placeholder={t('journal.fields.customer')}
                                size="sm"
                              />
                            ) : (
                              <SupplierPicker
                                value={
                                  field.value
                                    ? { id: field.value.id, name: field.value.name }
                                    : null
                                }
                                onChange={(s) =>
                                  field.onChange(
                                    s ? { type: 'supplier', id: s.id, name: s.name } : null,
                                  )
                                }
                                placeholder={t('journal.fields.supplier')}
                                size="sm"
                              />
                            )
                          }
                        />
                      </AccountingField>
                    ) : null}
                    <Input
                      {...form.register(`lines.${index}.memo`)}
                      size="sm"
                      maxLength={200}
                      placeholder={t('journal.fields.memo')}
                      aria-label={t('journal.fields.memo_n', { n: index + 1 })}
                      className={partyType ? undefined : 'sm:col-span-2'}
                    />
                  </div>
                </div>
              )
            })}
            <Button
              variant="ghost"
              leftIcon={<Plus />}
              onClick={addLine}
              disabled={lines.fields.length >= MANUAL_JOURNAL_MAX_LINES}
              className="self-start"
            >
              {t('journal.form.add_line')}
            </Button>
          </div>

          <div
            className={cn(
              'sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5',
              totals.balanced
                ? 'border-success/40 bg-success-soft text-success-soft-foreground'
                : empty
                  ? 'border-border bg-surface-2 text-muted-foreground'
                  : 'border-warning/40 bg-warning-soft text-warning-soft-foreground',
            )}
            aria-live="polite"
            data-testid="journal-balance"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Scale className="size-4" aria-hidden />
              {totals.balanced ? (
                <Badge tone="success" size="sm">
                  {t('journal.form.balanced')}
                </Badge>
              ) : empty ? (
                <span>{t('journal.form.enter_amounts')}</span>
              ) : (
                <span>
                  {t('journal.form.difference', {
                    amount: formatMoney(Math.abs(totals.difference_paise)),
                  })}
                </span>
              )}
            </div>
            <div className="flex gap-4 text-sm tabular-nums">
              <span>
                {t('journal.fields.debit')}: <b>{formatMoney(totals.debit_paise)}</b>
              </span>
              <span>
                {t('journal.fields.credit')}: <b>{formatMoney(totals.credit_paise)}</b>
              </span>
            </div>
          </div>
          {rootError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {rootError}
            </p>
          ) : null}
        </form>
      </FormProvider>
    </Dialog>
  )
}
