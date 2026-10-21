/**
 * Supplier quick view (drawer) reachable from the bills list, the bill editor and bill details:
 * payable balance, overdue, contact and the latest bills with their due — so the shopkeeper sees
 * "how much do I owe them" without leaving the screen. The full ledger lives in parties.
 */
import { getState } from '@kadai/shared/gst'
import { ArrowRight, FileText, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router'
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Money,
  PhoneLink,
  Skeleton,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { getLanguage } from '@/lib/i18n'
import { useBills, useSupplier } from '../api'
import type { SupplierLite } from '../lib/bill-form'
import { BillStatusBadge } from './StatusBadges'

export interface SupplierQuickViewProps {
  supplierId: string | null
  /** What is already known (shown while loading or without suppliers.read). */
  fallback?: Partial<SupplierLite> & { name?: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}

const RECENT_BILLS = 5

export function SupplierQuickView({ supplierId, fallback, open, onOpenChange }: SupplierQuickViewProps) {
  const { t } = useTranslation('purchases')
  const navigate = useNavigate()
  const canSuppliers = useCan('suppliers.read')
  const canWrite = useCan('purchases.write')
  const supplierQuery = useSupplier(supplierId, open && canSuppliers)
  const bills = useBills(
    { supplier_id: supplierId ?? undefined, limit: RECENT_BILLS, sort: '-received_date' },
    open && Boolean(supplierId),
  )
  const s = supplierQuery.data?.data
  const name = s?.name ?? fallback?.name ?? ''
  const phone = s?.phone ?? fallback?.phone ?? null
  const gstin = s?.gstin ?? fallback?.gstin ?? null
  const stateCode = s?.state_code ?? fallback?.state_code ?? null
  const state = stateCode ? getState(stateCode) : undefined
  const terms = s?.payment_terms_days ?? fallback?.payment_terms_days ?? null
  const balance = s?.balance_paise ?? fallback?.balance_paise ?? null
  const summary = bills.data?.summary
  const overdue = s?.overdue_paise ?? summary?.overdue_paise ?? 0
  const rows = bills.data?.data ?? []

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={name || t('supplier.title')}
      description={t('supplier.quick_view')}
      footer={
        <>
          {canSuppliers && supplierId ? (
            <Button variant="outline" asChild>
              <Link to={`/parties/suppliers/${supplierId}`}>
                {t('supplier.open_ledger')}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : null}
          {canWrite && supplierId ? (
            <Button
              leftIcon={<Plus />}
              onClick={() => {
                onOpenChange(false)
                navigate(`/purchases/bills/new?supplier_id=${supplierId}`)
              }}
            >
              {t('bills.new')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border bg-surface-2/50 p-3">
            <div className="text-xs text-muted-foreground">{t('supplier.payable')}</div>
            {balance === null && supplierQuery.isLoading ? (
              <Skeleton className="mt-1 h-6 w-24" />
            ) : (
              <div className="mt-0.5 text-lg font-bold">
                {balance !== null && balance < 0 ? (
                  <span className="text-success">
                    {t('supplier.advance', { amount: formatMoney(-balance) })}
                  </span>
                ) : (
                  <Money paise={balance ?? 0} />
                )}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-surface-2/50 p-3">
            <div className="text-xs text-muted-foreground">{t('supplier.overdue')}</div>
            <div className={overdue > 0 ? 'mt-0.5 text-lg font-bold text-danger' : 'mt-0.5 text-lg font-bold'}>
              <Money paise={overdue} />
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('supplier.phone')}</dt>
          <dd>
            <PhoneLink phone={phone} whatsapp />
          </dd>
          <dt className="text-muted-foreground">{t('supplier.gstin')}</dt>
          <dd className="font-mono text-xs leading-5">{gstin ?? t('supplier.unregistered')}</dd>
          <dt className="text-muted-foreground">{t('supplier.state')}</dt>
          <dd>{state ? (getLanguage() === 'ta' ? state.name_ta : state.name_en) : '—'}</dd>
          <dt className="text-muted-foreground">{t('supplier.terms')}</dt>
          <dd>
            {terms === null ? t('supplier.terms_none') : t('supplier.terms_days', { count: terms })}
          </dd>
          {s?.last_bill_date ? (
            <>
              <dt className="text-muted-foreground">{t('supplier.last_bill')}</dt>
              <dd className="tabular-nums">{formatDate(s.last_bill_date)}</dd>
            </>
          ) : null}
        </dl>

        <section aria-labelledby="supplier-recent-bills" className="grid gap-2">
          <h3 id="supplier-recent-bills" className="text-sm font-semibold">
            {t('supplier.recent_bills')}
          </h3>
          {bills.isLoading ? (
            <div className="grid gap-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState compact icon={<FileText />} title={t('supplier.no_bills')} />
          ) : (
            <ul className="grid gap-2">
              {rows.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/purchases/bills/${b.id}`}
                    onClick={() => onOpenChange(false)}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {b.number ?? t('bills.draft_number')}
                        </span>
                        <BillStatusBadge status={b.status} />
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {t('bills.invoice_ref', {
                          no: b.supplier_invoice_no || '—',
                          date: formatDate(b.supplier_invoice_date),
                        })}
                      </div>
                    </div>
                    <div className="shrink-0 text-end text-sm">
                      <Money paise={b.total_paise} className="font-medium" />
                      {b.status === 'posted' && b.due_paise > 0 ? (
                        <div>
                          <Badge tone={b.overdue ? 'danger' : 'warning'} size="sm">
                            {t('bills.due_amount', { amount: formatMoney(b.due_paise) })}
                          </Badge>
                        </div>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Drawer>
  )
}
