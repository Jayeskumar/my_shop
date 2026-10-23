/**
 * Loyalty tab (plan feature `loyalty`): points balance and rupee value, the points ledger
 * (GET /customers/:id/loyalty, newest first, with balance after each entry) and a manual
 * adjustment (POST /customers/:id/loyalty/adjust; audited, never below zero).
 */
import { Gift, Minus, Plus, Settings2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { documentPath } from '@kadai/shared/api/identity'
import { newId } from '@kadai/shared/ids'
import {
  type Customer,
  LOYALTY_KIND_LABELS,
  type LoyaltyEntry,
  LoyaltyAdjustSchema,
  loyaltyValuePaise,
} from '@kadai/shared/api/parties'
import { LoyaltyKindSchema, type LoyaltyKind } from '@kadai/shared/enums'
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  Dialog,
  EmptyState,
  FormField,
  NumberInput,
  RadioGroup,
  Select,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useCan, useMe } from '@/lib/auth'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { useAdjustLoyalty, useCustomerLoyalty } from '../api'
import { pickLabel } from '../lib/labels'
import { useValidationKeyText } from '../lib/validation-text'

const KINDS = LoyaltyKindSchema.options

export function LoyaltyPanel({ customer }: { customer: Customer }) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const me = useMe()
  const canWrite = useCan('customers.write')
  const canSettings = useCan('settings.manage')
  const settings = me?.settings.loyalty
  const [kind, setKind] = useState<LoyaltyKind | 'all'>('all')
  const [page, setPage] = useState({ offset: 0, limit: 20 })
  const [adjustOpen, setAdjustOpen] = useState(false)
  const list = useCustomerLoyalty(customer.id, {
    ...page,
    ...(kind === 'all' ? {} : { kind }),
  })

  const columns = useMemo<DataTableColumn<LoyaltyEntry>[]>(
    () => [
      {
        id: 'created_at',
        header: t('loyalty.col_date'),
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatDateTime(row.original.created_at)}</span>
        ),
      },
      {
        id: 'kind',
        header: t('loyalty.col_kind'),
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              size="sm"
              tone={
                row.original.points > 0
                  ? 'success'
                  : row.original.kind === 'expire'
                    ? 'neutral'
                    : 'warning'
              }
            >
              {pickLabel(LOYALTY_KIND_LABELS[row.original.kind], i18n.language)}
            </Badge>
            <RefLink entry={row.original} />
          </div>
        ),
      },
      {
        id: 'points',
        header: t('loyalty.col_points'),
        meta: { align: 'right', label: t('loyalty.col_points') },
        cell: ({ row }) => (
          <span
            className={
              row.original.points > 0
                ? 'font-semibold tabular-nums text-success'
                : 'font-semibold tabular-nums text-danger'
            }
          >
            {row.original.points > 0 ? '+' : '−'}
            {formatNumber(Math.abs(row.original.points))}
          </span>
        ),
      },
      {
        id: 'balance_after',
        header: t('loyalty.col_balance'),
        meta: { align: 'right', label: t('loyalty.col_balance') },
        cell: ({ row }) => (
          <span className="tabular-nums">{formatNumber(row.original.balance_after)}</span>
        ),
      },
      {
        id: 'notes',
        header: t('loyalty.col_notes'),
        meta: { label: t('loyalty.col_notes') },
        cell: ({ row }) => (
          <div className="min-w-0 text-sm">
            <div className="truncate">{row.original.notes ?? '—'}</div>
            {row.original.created_by_name ? (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.created_by_name}
              </div>
            ) : null}
          </div>
        ),
      },
    ],
    [t, i18n.language],
  )

  return (
    <div className="grid gap-4">
      {settings && !settings.enabled ? (
        <div className="flex flex-col gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>{t('loyalty.disabled_note')}</span>
          {canSettings ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/settings">
                <Settings2 aria-hidden />
                {t('loyalty.open_settings')}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      <Card className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-foreground">
            <Gift className="size-6" aria-hidden />
          </span>
          <div>
            <p className="text-sm text-muted-foreground">{t('loyalty.balance')}</p>
            <p className="text-2xl font-bold tabular-nums">
              {t('loyalty.points', {
                count: customer.loyalty_points,
                formatted: formatNumber(customer.loyalty_points),
              })}
            </p>
            {settings ? (
              <p className="text-xs text-muted-foreground">
                {t('loyalty.worth', {
                  amount: formatMoney(loyaltyValuePaise(customer.loyalty_points, settings)),
                })}
                {settings.min_redeem_points > 0
                  ? ` · ${t('loyalty.min_redeem', { points: formatNumber(settings.min_redeem_points) })}`
                  : ''}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select<LoyaltyKind | 'all'>
            value={kind}
            onValueChange={(v) => {
              setKind(v)
              setPage((p) => ({ ...p, offset: 0 }))
            }}
            options={[
              { value: 'all', label: t('loyalty.all_entries') },
              ...KINDS.map((k) => ({
                value: k,
                label: pickLabel(LOYALTY_KIND_LABELS[k], i18n.language),
              })),
            ]}
            className="w-52"
            aria-label={t('loyalty.col_kind')}
          />
          {canWrite ? (
            <Button variant="outline" onClick={() => setAdjustOpen(true)}>
              {t('loyalty.adjust')}
            </Button>
          ) : null}
        </div>
      </Card>
      <DataTable
        label={t('loyalty.title')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(e) => e.id}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        pagination={list.data ? { ...list.data.page, onChange: setPage } : undefined}
        empty={
          <EmptyState
            compact
            icon={<Gift />}
            title={t('loyalty.empty_title')}
            description={t('loyalty.empty_description')}
          />
        }
      />
      <LoyaltyAdjustDialog open={adjustOpen} onOpenChange={setAdjustOpen} customer={customer} />
    </div>
  )
}

function RefLink({ entry }: { entry: LoyaltyEntry }) {
  if (!entry.ref_number) return null
  const path = documentPath(entry.ref_type, entry.ref_id)
  return path ? (
    <Link
      to={path}
      className="font-mono text-xs text-primary hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {entry.ref_number}
    </Link>
  ) : (
    <span className="font-mono text-xs text-muted-foreground">{entry.ref_number}</span>
  )
}

export function LoyaltyAdjustDialog({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  customer: Customer
}) {
  const { t } = useTranslation(['parties', 'common'])
  const keyText = useValidationKeyText()
  const [direction, setDirection] = useState<'add' | 'remove'>('add')
  const [points, setPoints] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<{ points?: string; notes?: string }>({})
  // One Idempotency-Key per adjustment: a double tap or a retried request is applied once.
  const idempotencyKey = useRef(newId())
  const adjust = useAdjustLoyalty()

  const reset = (): void => {
    setDirection('add')
    setPoints(null)
    setNotes('')
    setErrors({})
    idempotencyKey.current = newId()
  }

  const submit = (): void => {
    const signed = (points ?? 0) * (direction === 'remove' ? -1 : 1)
    const body = { points: signed, notes }
    const parsed = LoyaltyAdjustSchema.safeParse(body)
    if (!parsed.success) {
      const next: { points?: string; notes?: string } = {}
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] === 'notes' ? 'notes' : 'points'
        next[field] ??= keyText(issue.message) ?? t('validation.invalid_points')
      }
      if (next.notes) next.notes = t('loyalty.notes_required')
      setErrors(next)
      return
    }
    if (direction === 'remove' && (points ?? 0) > customer.loyalty_points) {
      setErrors({ points: t('validation.loyalty_insufficient') })
      return
    }
    adjust.mutate(
      { params: { id: customer.id }, body: parsed.data, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (res) => {
          notify.success(
            t('loyalty.adjusted_toast', { points: formatNumber(res.data.loyalty_points) }),
          )
          reset()
          onOpenChange(false)
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
      title={t('loyalty.adjust_title')}
      description={t('loyalty.adjust_description', {
        points: formatNumber(customer.loyalty_points),
      })}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adjust.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} loading={adjust.isPending}>
            {t('common:actions.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 pb-2">
        <RadioGroup<'add' | 'remove'>
          value={direction}
          onValueChange={setDirection}
          orientation="horizontal"
          variant="cards"
          options={[
            { value: 'add', label: t('loyalty.add_points'), icon: <Plus /> },
            { value: 'remove', label: t('loyalty.remove_points'), icon: <Minus /> },
          ]}
          aria-label={t('loyalty.adjust_title')}
        />
        <FormField label={t('loyalty.points_label')} required error={errors.points}>
          <NumberInput value={points} onChange={setPoints} min={1} autoFocus />
        </FormField>
        <FormField
          label={t('loyalty.reason')}
          required
          error={errors.notes}
          hint={t('loyalty.reason_hint')}
        >
          <Textarea
            rows={2}
            maxLength={200}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>
      </div>
    </Dialog>
  )
}
