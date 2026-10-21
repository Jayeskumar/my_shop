/**
 * Shift report (/accounting/shifts/:id): the live X report while the shift is open (refreshed
 * every minute) or the stored Z report once closed. Print on the 80 mm counter printer or A4;
 * cash in / out and close (with the denomination count) when the member may (can_close /
 * can_add_cash_entry from the server: own shift or shifts.manage).
 */
import { ArrowDownUp, LogOut, Printer } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { isUuid } from '@kadai/shared/ids'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ErrorFallback,
  PageHeader,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { formatDateTime } from '@/lib/format'
import { useShift } from '../api'
import { CashEntryDialog } from '../components/CashEntryDialog'
import { CloseShiftDialog } from '../components/CloseShiftDialog'
import { ShiftReport } from '../components/ShiftReport'
import { ShiftStatusBadge } from '../components/ShiftStatusBadge'
import { printShiftReport } from '../lib/print'

export default function ShiftDetailPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const params = useParams()
  const id = params.id && isUuid(params.id) ? params.id : null
  const query = useShift(id)
  const shift = query.data?.data
  const [cashOpen, setCashOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const confirm = useConfirm()

  const print = (paper: 'thermal_80' | 'a4') => {
    if (!shift) return
    printShiftReport(shift, paper).catch((e: unknown) => notify.error(e))
  }

  if (!id || query.error) {
    return (
      <div>
        <PageHeader title={t('shift_report.title')} backTo="/accounting/shifts" />
        <ErrorFallback
          error={query.error ?? new Error('not found')}
          reset={() => void query.refetch()}
        />
      </div>
    )
  }

  if (!shift) {
    return (
      <div aria-busy>
        <PageHeader title={t('shift_report.title')} backTo="/accounting/shifts" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    )
  }

  const isOpen = shift.status === 'open'
  return (
    <div>
      <PageHeader
        backTo="/accounting/shifts"
        title={`${t(isOpen ? 'shift_report.x_title' : 'shift_report.z_title')} · ${shift.register_code} · ${shift.register_name}`}
        meta={
          <ShiftStatusBadge
            status={shift.status}
            differenceStatus={shift.difference_status}
            differencePaise={shift.difference_paise}
          />
        }
        description={[
          t('shift_report.cashier', { name: shift.opened_by_name ?? '—' }),
          t('shift_report.opened', { time: formatDateTime(shift.opened_at) }),
          shift.closed_at
            ? t('shift_report.closed', { time: formatDateTime(shift.closed_at) })
            : null,
          shift.closed_by_name && shift.closed_by !== shift.opened_by
            ? t('shift_report.closed_by', { name: shift.closed_by_name })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" leftIcon={<Printer />}>
                  {t('common:actions.print')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => print('thermal_80')}>
                  {t('shift_report.print_thermal')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => print('a4')}>
                  {t('shift_report.print_a4')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {isOpen && shift.can_add_cash_entry ? (
              <Button
                variant="outline"
                leftIcon={<ArrowDownUp />}
                onClick={() => setCashOpen(true)}
              >
                {t('shifts.cash_in_out')}
              </Button>
            ) : null}
            {isOpen && shift.can_close ? (
              <Button leftIcon={<LogOut />} onClick={() => setCloseOpen(true)}>
                {t('shifts.close_shift')}
              </Button>
            ) : null}
          </>
        }
      />
      <ShiftReport shift={shift} />
      {/* Kept mounted after closing so the mutation callbacks (toast, print prompt) still run. */}
      <CashEntryDialog open={cashOpen} onOpenChange={setCashOpen} shift={shift} />
      <CloseShiftDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        shift={shift}
        onClosed={(closed) => {
          void confirm({
            title: t('shifts.close.print_prompt'),
            confirmLabel: t('shift_report.print_thermal'),
            cancelLabel: t('shifts.close.print_later'),
          }).then((ok) => {
            if (ok) printShiftReport(closed, 'thermal_80').catch((e: unknown) => notify.error(e))
          })
        }}
      />
    </div>
  )
}
