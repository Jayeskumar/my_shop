/**
 * New purchase return / debit note (/purchases/returns/new):
 *  - ?bill_id= — against a posted bill (its returnable lines);
 *  - ?batch_ids=…&store_id=&supplier_id= — free-form lines for those batches with their stock
 *    (the inventory batches page links here with purchaseReturnPrefillPath(), e.g. expiry returns);
 *  - nothing — choose: pick the supplier's bill, or a return without a bill.
 */
import { parseInventoryPrefill } from '@kadai/shared/api/inventory'
import { todayIn } from '@kadai/shared/fy'
import { isUuid } from '@kadai/shared/ids'
import { FileText, PackageX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { SupplierPicker } from '@/components/pickers'
import { Button, Card, EmptyState, FormField, Money, PageHeader, Skeleton } from '@/components/ui'
import { useCan, useCurrentStore, useMe } from '@/lib/auth'
import { formatDate, formatMoney } from '@/lib/format'
import { useBillReturnable, useBills, useDebitNotePrefill, useSupplier } from '../api'
import { DetailError, DetailSkeleton } from '../components/PageState'
import { ReturnEditor } from '../components/ReturnEditor'
import {
  type ReturnDraft,
  billReturnDraft,
  emptyReturnHeader,
  freeLinesFromPrefill,
  prefillReason,
} from '../lib/return-form'

export default function ReturnNewPage() {
  const [params] = useSearchParams()
  const location = useLocation()
  const billId = params.get('bill_id')
  const prefill = useMemo(() => parseInventoryPrefill(location.search), [location.search])
  if (billId && isUuid(billId)) return <FromBill billId={billId} />
  if (prefill.batch_ids.length > 0) return <FromBatches prefill={prefill} />
  if (params.get('mode') === 'free') return <FreeForm supplierId={prefill.supplier_id} />
  return <Chooser />
}

function useDefaults() {
  const me = useMe()
  const current = useCurrentStore()
  const today = todayIn(me?.tenant.timezone)
  return { me, today, storeId: current?.id ?? me?.stores.find((s) => s.is_active)?.id ?? null }
}

function FromBill({ billId }: { billId: string }) {
  const { t } = useTranslation('purchases')
  const { today, storeId } = useDefaults()
  const query = useBillReturnable(billId)
  const data = query.data?.data
  const draft = useMemo<ReturnDraft | null>(
    () => (data ? billReturnDraft(data, emptyReturnHeader({ store_id: storeId, today })) : null),
    [data, storeId, today],
  )
  if (query.isLoading) return <DetailSkeleton />
  if (!data || !draft) {
    return (
      <DetailError
        error={query.error}
        backTo="/purchases/returns"
        backLabel={t('returns.back_to_list')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  if (data.bill.status !== 'posted') {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface">
        <EmptyState
          icon={<FileText />}
          title={t('errors.bill_not_posted')}
          action={
            <Button variant="outline" asChild>
              <Link to={`/purchases/bills/${billId}`}>{t('returns.open_bill')}</Link>
            </Button>
          }
        />
      </div>
    )
  }
  return <ReturnEditor initial={draft} />
}

function FromBatches({ prefill }: { prefill: ReturnType<typeof parseInventoryPrefill> }) {
  const { t } = useTranslation('purchases')
  const { me, today, storeId: currentStore } = useDefaults()
  const storeId =
    prefill.store_id && me?.stores.some((s) => s.id === prefill.store_id)
      ? prefill.store_id
      : currentStore
  const query = useDebitNotePrefill(
    storeId
      ? {
          batch_ids: prefill.batch_ids,
          store_id: storeId,
          ...(prefill.supplier_id ? { supplier_id: prefill.supplier_id } : {}),
        }
      : null,
  )
  const supplier = useSupplier(query.data?.data.supplier?.id ?? prefill.supplier_id)
  const data = query.data?.data
  const draft = useMemo<ReturnDraft | null>(() => {
    if (!data) return null
    const s = supplier.data?.data
    return {
      mode: 'free',
      header: {
        ...emptyReturnHeader({ store_id: storeId, today, reason: prefillReason(data, today) }),
        supplier: s
          ? { id: s.id, name: s.name, state_code: s.state_code }
          : data.supplier
            ? { id: data.supplier.id, name: data.supplier.name, state_code: null }
            : null,
      },
      lines: freeLinesFromPrefill(data),
    }
  }, [data, supplier.data, storeId, today])

  if (query.isLoading || supplier.isLoading) return <DetailSkeleton />
  if (!draft || !data) {
    return (
      <DetailError
        error={query.error}
        backTo="/purchases/returns"
        backLabel={t('returns.back_to_list')}
        onRetry={() => void query.refetch()}
      />
    )
  }
  const suppliers = new Set(data.lines.map((l) => l.supplier_name).filter(Boolean))
  return (
    <ReturnEditor
      initial={draft}
      sourceNote={
        <>
          {t('returns.prefill_note', { count: data.lines.length })}
          {!data.supplier && suppliers.size > 1 ? (
            <div className="mt-1 font-medium text-warning">
              {t('returns.prefill_many_suppliers', { names: [...suppliers].join(', ') })}
            </div>
          ) : null}
        </>
      }
    />
  )
}

function FreeForm({ supplierId }: { supplierId: string | null }) {
  const { today, storeId } = useDefaults()
  const supplier = useSupplier(supplierId)
  if (supplierId && supplier.isLoading) return <DetailSkeleton />
  const s = supplier.data?.data
  return (
    <ReturnEditor
      initial={{
        mode: 'free',
        header: {
          ...emptyReturnHeader({ store_id: storeId, today, reason: 'expired' }),
          supplier: s ? { id: s.id, name: s.name, state_code: s.state_code } : null,
        },
        lines: [],
      }}
    />
  )
}

/** No prefill: pick one of the supplier's posted bills, or return without a bill. */
function Chooser() {
  const { t } = useTranslation(['purchases', 'common'])
  const navigate = useNavigate()
  const canSuppliers = useCan('suppliers.read')
  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null)
  const bills = useBills(
    { supplier_id: supplier?.id, status: ['posted'], sort: '-received_date', limit: 20 },
    Boolean(supplier),
  )
  const rows = bills.data?.data ?? []
  return (
    <div>
      <PageHeader
        title={t('returns.new_title')}
        description={t('returns.choose_description')}
        backTo="/purchases/returns"
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="grid content-start gap-3 p-4">
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-primary" aria-hidden />
            <h2 className="text-base font-semibold">{t('returns.against_bill_title')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('returns.against_bill_hint')}</p>
          {canSuppliers ? (
            <FormField label={t('editor.supplier')}>
              <SupplierPicker
                size="lg"
                value={supplier}
                onChange={(s) => setSupplier(s ? { id: s.id, name: s.name } : null)}
              />
            </FormField>
          ) : null}
          {supplier ? (
            bills.isLoading ? (
              <div className="grid gap-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('returns.no_posted_bills')}</p>
            ) : (
              <ul className="grid gap-2" aria-label={t('returns.pick_bill')}>
                {rows.map((b) => (
                  <li key={b.id}>
                    <Link
                      to={`/purchases/returns/new?bill_id=${b.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{b.number}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {t('bills.invoice_ref', {
                            no: b.supplier_invoice_no,
                            date: formatDate(b.received_date),
                          })}
                        </div>
                      </div>
                      <div className="shrink-0 text-end">
                        <Money paise={b.total_paise} className="font-medium" />
                        {b.due_paise > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            {t('bills.due_amount', { amount: formatMoney(b.due_paise) })}
                          </div>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Card>
        <Card className="grid content-start gap-3 p-4">
          <div className="flex items-center gap-2">
            <PackageX className="size-5 text-accent" aria-hidden />
            <h2 className="text-base font-semibold">{t('returns.free_form_title')}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{t('returns.free_form_hint')}</p>
          <div>
            <Button variant="outline" onClick={() => navigate('/purchases/returns/new?mode=free')}>
              {t('returns.start_free_form')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  )
}
