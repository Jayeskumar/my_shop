/**
 * Expense detail (GET /expenses/:id) in a drawer opened by `?id=` (JOURNAL_SOURCE_ROUTES links
 * from books land here too): amounts with the GST split and ITC, how and from where it was paid,
 * the supplier and what is still due on credit, the bill photo, who recorded it, the journal
 * entry, and Cancel (reversal journal, reason required, confirm) when the server allows it.
 */
import { Ban, ExternalLink, FileText } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type ExpenseDetail, ExpenseCancelSchema } from '@kadai/shared/api/accounting'
import {
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  ErrorFallback,
  FormField,
  Skeleton,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useCan, useFeature } from '@/lib/auth'
import { formatBp, formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useCancelExpense, useExpense } from '../api'
import { useAttachmentUrl, useFileMeta } from '../lib/files'
import { notifyAccountingError, validationText } from '../lib/errors'
import { accountName, expenseMethodLabel, paymentMethodLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'

export function ExpenseDetailDrawer({
  expenseId,
  onClose,
}: {
  expenseId: string | null
  onClose: () => void
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const query = useExpense(expenseId)
  const expense = query.data?.data
  return (
    <Drawer
      open={Boolean(expenseId)}
      onOpenChange={(o) => !o && onClose()}
      title={
        expense?.number
          ? t('expenses.detail.title_number', { number: expense.number })
          : t('expenses.detail.title')
      }
      className="sm:max-w-lg"
    >
      {query.error ? (
        <ErrorFallback error={query.error} reset={() => void query.refetch()} />
      ) : !expense ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <ExpenseDetailBody expense={expense} />
      )}
    </Drawer>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end text-sm">{children}</dd>
    </div>
  )
}

function ExpenseDetailBody({ expense }: { expense: ExpenseDetail }) {
  const { t } = useTranslation(['accounting', 'common'])
  const canWrite = useCan('expenses.write')
  const canReadAccounts = useCan('accounting.read')
  const hasAccounting = useFeature('accounting')
  const canReadBooks = canReadAccounts && hasAccounting
  const tenant = useTenantInfo()
  const cancel = useCancelExpense()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const cancelled = expense.status === 'cancelled'

  const doCancel = async (): Promise<void> => {
    const body = { reason: reason.trim(), date: tenant.today }
    const parsed = ExpenseCancelSchema.safeParse(body)
    if (!parsed.success) {
      setReasonError(validationText(parsed.error.issues[0]?.message) ?? null)
      throw new Error('invalid')
    }
    try {
      await cancel.mutateAsync({ params: { id: expense.id }, body })
      notify.success(t('expenses.detail.cancelled_toast', { number: expense.number ?? '' }))
    } catch (error) {
      notifyAccountingError(error)
      throw error
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{formatDate(expense.expense_date)}</div>
          <div className="truncate text-lg font-semibold">
            {accountName({
              name: expense.expense_account_name,
              name_ta: expense.expense_account_name_ta,
            })}
          </div>
          {expense.description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">{expense.description}</p>
          ) : null}
        </div>
        <div className="text-end">
          <div
            className={
              cancelled
                ? 'text-xl font-semibold tabular-nums line-through opacity-60'
                : 'text-xl font-semibold tabular-nums'
            }
          >
            {formatMoney(expense.total_paise)}
          </div>
          <Badge tone={cancelled ? 'danger' : 'success'} size="sm" className="mt-1">
            {t(cancelled ? 'expenses.status.cancelled' : 'expenses.status.posted')}
          </Badge>
        </div>
      </div>

      {cancelled ? (
        <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
          <div className="font-medium">
            {t('expenses.detail.cancelled_by', {
              name: expense.cancelled_by_name ?? '—',
              time: formatDateTime(expense.cancelled_at),
            })}
          </div>
          {expense.cancel_reason ? <div>{expense.cancel_reason}</div> : null}
        </div>
      ) : null}

      <section>
        <h3 className="mb-1 text-sm font-semibold">{t('expenses.detail.amounts')}</h3>
        <dl className="divide-y divide-border rounded-lg border border-border px-3">
          <Row label={t('expenses.fields.taxable')}>
            <span className="tabular-nums">{formatMoney(expense.taxable_paise)}</span>
          </Row>
          {expense.tax_paise > 0 ? (
            <>
              <Row label={t('expenses.detail.gst_rate')}>{formatBp(expense.gst_rate_bp)}</Row>
              {expense.is_interstate ? (
                <Row label="IGST">
                  <span className="tabular-nums">{formatMoney(expense.igst_paise)}</span>
                </Row>
              ) : (
                <>
                  <Row label="CGST">
                    <span className="tabular-nums">{formatMoney(expense.cgst_paise)}</span>
                  </Row>
                  <Row label="SGST">
                    <span className="tabular-nums">{formatMoney(expense.sgst_paise)}</span>
                  </Row>
                </>
              )}
              <Row label={t('expenses.detail.itc')}>
                {expense.itc_eligible ? (
                  <Badge tone="success" size="sm">
                    {t('expenses.detail.itc_claimed')}
                  </Badge>
                ) : (
                  t('expenses.detail.itc_not_claimed')
                )}
              </Row>
            </>
          ) : null}
          <Row label={t('expenses.fields.total')}>
            <span className="font-semibold tabular-nums">{formatMoney(expense.total_paise)}</span>
          </Row>
        </dl>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold">{t('expenses.detail.payment')}</h3>
        <dl className="divide-y divide-border rounded-lg border border-border px-3">
          <Row label={t('expenses.fields.paid_via')}>
            {expenseMethodLabel(expense.payment_method)}
          </Row>
          {expense.paid_from_account_name ? (
            <Row label={t('expenses.fields.paid_from')}>{expense.paid_from_account_name}</Row>
          ) : null}
          {expense.supplier_name ? (
            <Row label={t('expenses.fields.supplier')}>
              {expense.supplier_id ? (
                <Link
                  className="text-primary underline-offset-4 hover:underline"
                  to={`/parties/suppliers/${expense.supplier_id}`}
                >
                  {expense.supplier_name}
                </Link>
              ) : (
                expense.supplier_name
              )}
            </Row>
          ) : null}
          {expense.payment_method === 'credit' ? (
            <>
              <Row label={t('expenses.detail.paid')}>
                <span className="tabular-nums">{formatMoney(expense.paid_paise)}</span>
              </Row>
              <Row label={t('expenses.detail.due')}>
                <span
                  className={
                    expense.due_paise > 0
                      ? 'font-semibold text-danger tabular-nums'
                      : 'tabular-nums'
                  }
                >
                  {formatMoney(expense.due_paise)}
                </span>
              </Row>
            </>
          ) : null}
          {expense.reference ? (
            <Row label={t('expenses.fields.reference')}>{expense.reference}</Row>
          ) : null}
          <Row label={t('common:fields.store')}>{expense.store_name}</Row>
          {expense.shift_id ? (
            <Row label={t('expenses.detail.shift')}>
              <Link
                className="text-primary underline-offset-4 hover:underline"
                to={`/accounting/shifts/${expense.shift_id}`}
              >
                {t('expenses.detail.view_shift')}
              </Link>
            </Row>
          ) : null}
        </dl>
        {expense.payments.length ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {expense.payments.map((p) => (
              <li
                key={p.payment_id}
                className="flex justify-between gap-3 rounded-md bg-surface-2/60 px-3 py-1.5"
              >
                <span>
                  {formatDate(p.payment_date)} · {paymentMethodLabel(p.method)}
                  {p.number ? ` · ${p.number}` : ''}
                </span>
                <span className="tabular-nums">{formatMoney(p.amount_paise)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {expense.attachment_file_id ? <BillPhoto fileId={expense.attachment_file_id} /> : null}

      <section className="text-xs text-muted-foreground">
        {t('expenses.detail.recorded_by', {
          name: expense.created_by_name ?? '—',
          time: formatDateTime(expense.created_at),
        })}
      </section>

      <div className="flex flex-wrap gap-2">
        {canReadBooks && expense.journal_entry_id ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/accounting/journal?id=${expense.journal_entry_id}`}>
              <ExternalLink aria-hidden />
              {t('expenses.detail.view_journal')}
            </Link>
          </Button>
        ) : null}
        {canWrite && expense.can_cancel ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Ban />}
            className="text-danger"
            onClick={() => setCancelOpen(true)}
          >
            {t('expenses.detail.cancel')}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(o) => {
          setCancelOpen(o)
          if (!o) {
            setReason('')
            setReasonError(null)
          }
        }}
        tone="danger"
        title={t('expenses.detail.cancel_title', { amount: formatMoney(expense.total_paise) })}
        description={t('expenses.detail.cancel_description')}
        confirmLabel={t('expenses.detail.cancel_confirm')}
        onConfirm={doCancel}
      >
        <FormField label={t('expenses.detail.cancel_reason')} required error={reasonError}>
          <Textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              setReasonError(null)
            }}
            rows={2}
            maxLength={500}
            autoFocus
          />
        </FormField>
      </ConfirmDialog>
    </div>
  )
}

function BillPhoto({ fileId }: { fileId: string }) {
  const { t } = useTranslation('accounting')
  const meta = useFileMeta(fileId)
  const content = useAttachmentUrl(fileId)
  const isImage = (content.type ?? meta.data?.data.content_type ?? '').startsWith('image/')
  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t('expenses.fields.photo')}</h3>
      {content.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : content.url && isImage ? (
        <a href={content.url} target="_blank" rel="noreferrer">
          <img
            src={content.url}
            alt={t('expenses.fields.photo')}
            className="max-h-72 w-full rounded-lg border border-border object-contain"
          />
        </a>
      ) : content.url ? (
        <Button asChild variant="outline" size="sm">
          <a href={content.url} target="_blank" rel="noreferrer">
            <FileText aria-hidden />
            {meta.data?.data.filename ?? t('expenses.photo.open')}
          </a>
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{t('expenses.photo.unavailable')}</p>
      )}
    </section>
  )
}
