/**
 * One journal entry (GET /journal-entries/:id) in a drawer opened by `?id=` — the source links of
 * manual JVs, expense and books rows land here: date, voucher number, narration, the source
 * document, every line (account, party, memo, debit, credit) with totals, and what it reverses /
 * was reversed by. Manual entries can be reversed once (date + reason; the server posts the
 * mirror entry and returns it).
 */
import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { type JournalEntryDetail, JournalReverseSchema } from '@kadai/shared/api/accounting'
import {
  Badge,
  Button,
  DatePicker,
  Dialog,
  Drawer,
  ErrorFallback,
  FormField,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  notify,
} from '@/components/ui'
import { Textarea } from '@/components/ui/textarea'
import { useCan } from '@/lib/auth'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { useJournalEntry, useReverseJournalEntry } from '../api'
import { notifyAccountingError, validationText } from '../lib/errors'
import { accountLabel, sourceTone, sourceTypeLabel } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'
import { SourceLink } from './SourceLink'

export function JournalEntryDrawer({
  entryId,
  onClose,
  onOpenEntry,
}: {
  entryId: string | null
  onClose: () => void
  /** Open another entry (reversal links). */
  onOpenEntry: (id: string) => void
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const query = useJournalEntry(entryId)
  const entry = query.data?.data
  return (
    <Drawer
      open={Boolean(entryId)}
      onOpenChange={(o) => !o && onClose()}
      title={entry?.number ?? entry?.source_number ?? t('journal.detail.title')}
      className="sm:max-w-2xl"
    >
      {query.error ? (
        <ErrorFallback error={query.error} reset={() => void query.refetch()} />
      ) : !entry ? (
        <div className="flex flex-col gap-3" aria-busy>
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <JournalEntryBody entry={entry} onOpenEntry={onOpenEntry} />
      )}
    </Drawer>
  )
}

function JournalEntryBody({
  entry,
  onOpenEntry,
}: {
  entry: JournalEntryDetail
  onOpenEntry: (id: string) => void
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const canWrite = useCan('accounting.write')
  const [reverseOpen, setReverseOpen] = useState(false)
  const totalDebit = entry.lines.reduce((n, l) => n + l.debit_paise, 0)
  const totalCredit = entry.lines.reduce((n, l) => n + l.credit_paise, 0)
  const reverses = entry.reverses
  const reversedBy = entry.reversed_by

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={sourceTone(entry.source_type)} size="sm">
              {sourceTypeLabel(entry.source_type)}
            </Badge>
            {entry.reversed_by_entry_id ? (
              <Badge tone="danger" size="sm">
                {t('journal.reversed')}
              </Badge>
            ) : null}
            {entry.reverses_entry_id ? (
              <Badge tone="warning" size="sm">
                {t('journal.reversal')}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {[formatDate(entry.entry_date), entry.store_name].filter(Boolean).join(' · ')}
          </div>
          {entry.narration ? <p className="mt-1 text-sm">{entry.narration}</p> : null}
        </div>
        <div className="text-end">
          <div className="text-xl font-semibold tabular-nums">{formatMoney(entry.total_paise)}</div>
          {entry.source.id && entry.source_type !== 'manual' ? (
            <SourceLink
              type={entry.source.type}
              number={entry.source.number}
              path={entry.source.path}
            />
          ) : null}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table aria-label={t('journal.detail.lines')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('journal.fields.account')}</TableHead>
              <TableHead className="text-end">{t('journal.fields.debit')}</TableHead>
              <TableHead className="text-end">{t('journal.fields.credit')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entry.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  <div className="font-medium">
                    {accountLabel({
                      code: l.account_code,
                      name: l.account_name,
                      name_ta: l.account_name_ta,
                    })}
                  </div>
                  {l.party_name || l.memo ? (
                    <div className="text-xs text-muted-foreground">
                      {[l.party_name, l.memo].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {l.debit_paise ? formatMoney(l.debit_paise) : ''}
                </TableCell>
                <TableCell className="text-end tabular-nums">
                  {l.credit_paise ? formatMoney(l.credit_paise) : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell className="font-semibold">{t('journal.detail.total')}</TableCell>
              <TableCell className="text-end font-semibold tabular-nums">
                {formatMoney(totalDebit)}
              </TableCell>
              <TableCell className="text-end font-semibold tabular-nums">
                {formatMoney(totalCredit)}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {reverses ? (
        <p className="text-sm">
          {t('journal.detail.reverses')}{' '}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => onOpenEntry(reverses.id)}
          >
            {reverses.number ?? formatDate(reverses.entry_date)}
          </button>
        </p>
      ) : null}
      {reversedBy ? (
        <p className="text-sm">
          {t('journal.detail.reversed_by')}{' '}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => onOpenEntry(reversedBy.id)}
          >
            {reversedBy.number ?? formatDate(reversedBy.entry_date)}
          </button>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t('journal.detail.created_by', {
          name: entry.created_by_name ?? t('journal.detail.system'),
          time: formatDateTime(entry.created_at),
        })}
      </p>

      {entry.source_type !== 'manual' && entry.source.path ? (
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to={entry.source.path}>
            {t('journal.detail.open_source', { type: sourceTypeLabel(entry.source_type) })}
          </Link>
        </Button>
      ) : null}

      {canWrite && entry.can_reverse ? (
        <Button
          variant="outline"
          leftIcon={<RotateCcw />}
          className="self-start text-danger"
          onClick={() => setReverseOpen(true)}
        >
          {t('journal.reverse.action')}
        </Button>
      ) : null}
      <ReverseDialog
        entry={entry}
        open={reverseOpen}
        onOpenChange={setReverseOpen}
        onReversed={(id) => onOpenEntry(id)}
      />
    </div>
  )
}

function ReverseDialog({
  entry,
  open,
  onOpenChange,
  onReversed,
}: {
  entry: JournalEntryDetail
  open: boolean
  onOpenChange: (open: boolean) => void
  onReversed: (reversalId: string) => void
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const mutation = useReverseJournalEntry()
  const [date, setDate] = useState<string | null>(tenant.today)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDate(tenant.today)
    setReason('')
    setError(null)
  }, [open, tenant.today])

  const submit = (): void => {
    const body = { reason: reason.trim(), ...(date ? { entry_date: date } : {}) }
    const parsed = JournalReverseSchema.safeParse(body)
    if (!parsed.success) {
      setError(validationText(parsed.error.issues[0]?.message) ?? null)
      return
    }
    mutation.mutate(
      { params: { id: entry.id }, body },
      {
        onSuccess: (res) => {
          notify.success(t('journal.reverse.done', { number: res.data.number ?? '' }))
          onOpenChange(false)
          onReversed(res.data.id)
        },
        onError: notifyAccountingError,
      },
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}
      title={t('journal.reverse.title', { number: entry.number ?? '' })}
      description={t('journal.reverse.description')}
      size="sm"
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            {t('common:actions.cancel')}
          </Button>
          <Button variant="danger" onClick={submit} loading={mutation.isPending}>
            {t('journal.reverse.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={t('journal.reverse.date')} required>
          <DatePicker value={date} onChange={setDate} min={entry.entry_date} max={tenant.today} />
        </FormField>
        <FormField label={t('journal.reverse.reason')} required error={error}>
          <Textarea
            value={reason}
            onChange={(e) => {
              setReason(e.target.value)
              setError(null)
            }}
            rows={2}
            maxLength={500}
            autoFocus
          />
        </FormField>
      </div>
    </Dialog>
  )
}
