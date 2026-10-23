/**
 * Supplier page (/parties/suppliers/:id): what the shop owes the supplier, overdue bills, quick
 * contact and UPI pay, and tabs for the payable ledger, purchase bills, payments and the
 * profile (drug licence for pharmacies, payment terms, bank account last 4 digits + IFSC, UPI).
 * "Pay supplier" records a payment voucher (payments contract, direction out).
 */
import {
  AlertTriangle,
  IndianRupee,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Phone,
  RotateCcw,
  Smartphone,
  Trash2,
  Truck,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { Supplier } from '@kadai/shared/api/parties'
import { toWhatsAppNumber } from '@kadai/shared/phone'
import { buildUpiUri } from '@kadai/shared/upi'
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Kbd,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  notify,
  useConfirm,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan, useFeature, useMe } from '@/lib/auth'
import { formatDate, formatMoney, formatPhone } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { translate } from '@/lib/i18n'
import { useDeleteSupplier, useSupplier, useUpdateSupplier } from '../api'
import { BalanceAmount } from '../components/BalanceAmount'
import { PartyPayments, SupplierBills } from '../components/PartyDocuments'
import { PartyLedgerPanel } from '../components/PartyLedgerPanel'
import { PartyPaymentDialog } from '../components/PartyPaymentDialog'
import { SupplierFormDialog } from '../components/SupplierFormDialog'
import { formatAddress, langOf, stateName, PARTIES_HOTKEY_SCOPE } from '../lib/labels'

const TABS = ['ledger', 'bills', 'payments', 'profile'] as const
type Tab = (typeof TABS)[number]

export default function SupplierDetailPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation(['parties', 'common'])
  const supplier = useSupplier(id)
  if (supplier.isLoading) {
    return (
      <div aria-busy>
        <Skeleton className="mb-5 h-8 w-64" />
        <Skeleton className="mb-5 h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (supplier.error || !supplier.data) {
    const notFound = isApiError(supplier.error) && supplier.error.status === 404
    return (
      <div>
        <PageHeader title={translate('nav:titles.supplier')} backTo="/parties/suppliers" />
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Truck />}
            title={notFound ? t('supplier.not_found') : t('khata.load_failed')}
            action={
              <>
                {!notFound ? (
                  <Button variant="outline" onClick={() => void supplier.refetch()}>
                    {t('common:actions.retry')}
                  </Button>
                ) : null}
                <Button asChild>
                  <Link to="/parties/suppliers">{t('supplier.back_to_list')}</Link>
                </Button>
              </>
            }
          />
        </div>
      </div>
    )
  }
  return <SupplierView supplier={supplier.data.data} />
}

function SupplierView({ supplier }: { supplier: Supplier }) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [params, setParams] = useSearchParams()
  const canWrite = useCan('suppliers.write')
  const canPay = useCan('payments.pay')
  const canPayments = useCan('payments.read')
  const canReadBills = useCan('purchases.read')
  const hasPurchases = useFeature('purchases')
  const canBills = canReadBills && hasPurchases
  const [dialog, setDialog] = useState<'pay' | 'edit' | null>(null)
  const del = useDeleteSupplier()
  const update = useUpdateSupplier()

  const tabs = TABS.filter((k) => (k !== 'bills' || canBills) && (k !== 'payments' || canPayments))
  const requested = params.get('tab') as Tab | null
  const tab: Tab = requested && tabs.includes(requested) ? requested : 'ledger'
  const balance = supplier.balance_paise
  const wa = supplier.phone ? toWhatsAppNumber(supplier.phone) : null
  let upiUri: string | null = null
  if (supplier.upi_vpa) {
    try {
      upiUri = buildUpiUri({
        vpa: supplier.upi_vpa,
        payee_name: supplier.name,
        ...(balance > 0 ? { amount_paise: balance } : {}),
      })
    } catch {
      upiUri = null
    }
  }

  useHotkeyScope(PARTIES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+p': () => {
        if (canPay) setDialog('pay')
      },
      'alt+e': () => {
        if (canWrite) setDialog('edit')
      },
    },
    { scope: PARTIES_HOTKEY_SCOPE },
  )

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('supplier.delete_title', { name: supplier.name }),
      description: t('supplier.delete_description'),
      confirmLabel: t('khata.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    del.mutate(
      { params: { id: supplier.id } },
      {
        onSuccess: (res) => {
          if (res.data.result === 'deleted') {
            notify.success(t('khata.deleted', { name: supplier.name }))
            navigate('/parties/suppliers', { replace: true })
          } else notify.info(t('khata.deactivated', { name: supplier.name }))
        },
        onError: (e) => notify.error(e),
      },
    )
  }

  const reactivate = (): void =>
    update.mutate(
      {
        params: { id: supplier.id },
        body: { is_active: true, if_updated_at: supplier.updated_at },
      },
      {
        onSuccess: () => notify.success(t('khata.reactivated', { name: supplier.name })),
        onError: (e) => notify.error(e),
      },
    )

  return (
    <div>
      <PageHeader
        title={supplier.name}
        backTo="/parties/suppliers"
        breadcrumbs={[
          { label: translate('nav:titles.suppliers'), to: '/parties/suppliers' },
          { label: supplier.name },
        ]}
        meta={!supplier.is_active ? <Badge>{t('common:status.inactive')}</Badge> : null}
      />

      <Card className="mb-5 grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 items-start gap-4 lg:col-start-1">
          <Avatar name={supplier.name} size="xl" className="hidden sm:inline-flex" />
          <div className="min-w-0 flex-1">
            {supplier.contact_person ? (
              <p className="text-sm text-muted-foreground">
                {t('supplier.contact', { name: supplier.contact_person })}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {supplier.phone ? (
                <>
                  <Button asChild variant="outline" size="lg">
                    <a href={`tel:${supplier.phone}`}>
                      <Phone aria-hidden />
                      <span className="tabular-nums">{formatPhone(supplier.phone)}</span>
                    </a>
                  </Button>
                  {wa ? (
                    <Button asChild variant="outline" size="lg">
                      <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">
                        <MessageCircle className="text-success" aria-hidden />
                        {t('khata.whatsapp')}
                      </a>
                    </Button>
                  ) : null}
                </>
              ) : (
                <span className="text-sm text-muted-foreground">{t('khata.no_phone')}</span>
              )}
            </div>
            {supplier.gstin ? (
              <p className="mt-3 font-mono text-xs text-muted-foreground">GSTIN {supplier.gstin}</p>
            ) : null}
          </div>
        </div>
        <div
          className="flex flex-col gap-3 rounded-xl bg-surface-2/70 p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          aria-live="polite"
        >
          <p className="text-sm font-medium text-muted-foreground">
            {balance > 0
              ? t('supplier.you_owe')
              : balance < 0
                ? t('supplier.advance_paid')
                : t('khata.all_settled')}
          </p>
          <BalanceAmount partyType="supplier" balancePaise={balance} size="xl" showLabel={false} />
          {supplier.overdue_paise > 0 ? (
            <div className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {t('supplier.overdue_line', { amount: formatMoney(supplier.overdue_paise) })}
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {supplier.payment_terms_days !== null
              ? t('supplier.terms', { count: supplier.payment_terms_days })
              : t('supplier.no_terms')}
            {supplier.last_bill_date
              ? ` · ${t('supplier.last_bill', { date: formatDate(supplier.last_bill_date) })}`
              : ''}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:col-start-1">
          {canPay ? (
            <Button
              size="lg"
              leftIcon={<IndianRupee />}
              onClick={() => setDialog('pay')}
              className="col-span-2 sm:col-span-1"
            >
              {t('supplier.pay')}
              <Kbd
                combo="alt+p"
                className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
              />
            </Button>
          ) : null}
          {upiUri ? (
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-auto min-h-12 whitespace-normal py-2 leading-tight md:hidden"
            >
              <a href={upiUri}>
                <Smartphone aria-hidden />
                {t('supplier.pay_upi_app')}
              </a>
            </Button>
          ) : null}
          {canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="lg"
                  variant="ghost"
                  leftIcon={<MoreHorizontal />}
                  aria-label={t('common:actions.more')}
                >
                  <span className="sm:sr-only">{t('common:actions.more')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  icon={<Pencil />}
                  shortcut={<Kbd combo="alt+e" />}
                  onSelect={() => setDialog('edit')}
                >
                  {t('supplier.edit')}
                </DropdownMenuItem>
                {supplier.is_active ? (
                  <DropdownMenuItem icon={<Trash2 />} tone="danger" onSelect={() => void remove()}>
                    {t('profile.delete')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem icon={<RotateCcw />} onSelect={reactivate}>
                    {t('profile.reactivate')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </Card>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev)
              if (v === 'ledger') next.delete('tab')
              else next.set('tab', v)
              return next
            },
            { replace: true },
          )
        }
      >
        <TabsList>
          {tabs.map((k) => (
            <TabsTrigger key={k} value={k}>
              {t(`supplier.tab_${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="ledger">
          <PartyLedgerPanel partyType="supplier" party={supplier} />
        </TabsContent>
        {canBills ? (
          <TabsContent value="bills">
            <SupplierBills supplierId={supplier.id} />
          </TabsContent>
        ) : null}
        {canPayments ? (
          <TabsContent value="payments">
            <PartyPayments partyType="supplier" partyId={supplier.id} />
          </TabsContent>
        ) : null}
        <TabsContent value="profile">
          <SupplierProfile
            supplier={supplier}
            canWrite={canWrite}
            onEdit={() => setDialog('edit')}
            lang={i18n.language}
          />
        </TabsContent>
      </Tabs>

      <PartyPaymentDialog
        open={dialog === 'pay'}
        onOpenChange={(o) => setDialog(o ? 'pay' : null)}
        party={{ type: 'supplier', id: supplier.id, name: supplier.name, balance_paise: balance }}
      />
      <SupplierFormDialog
        open={dialog === 'edit'}
        onOpenChange={(o) => setDialog(o ? 'edit' : null)}
        supplier={supplier}
      />
    </div>
  )
}

function SupplierProfile({
  supplier,
  canWrite,
  onEdit,
  lang,
}: {
  supplier: Supplier
  canWrite: boolean
  onEdit: () => void
  lang: string
}) {
  const { t } = useTranslation(['parties', 'common'])
  const me = useMe()
  const pharmacy = me?.tenant.business_type === 'pharmacy'
  const bank = supplier.bank_details
  const rows: { label: string; value: ReactNode }[] = [
    { label: t('fields.contact_person'), value: supplier.contact_person },
    { label: t('fields.phone'), value: supplier.phone ? formatPhone(supplier.phone, true) : null },
    { label: t('fields.email'), value: supplier.email },
    {
      label: t('fields.gstin'),
      value: supplier.gstin ? (
        <span className="inline-flex items-center gap-1 font-mono">
          {supplier.gstin}
          <CopyButton value={supplier.gstin} />
        </span>
      ) : null,
    },
    {
      label: t('fields.pan'),
      value: supplier.pan ? <span className="font-mono">{supplier.pan}</span> : null,
    },
    { label: t('fields.state'), value: stateName(supplier.state_code, lang) || null },
    { label: t('fields.address'), value: formatAddress(supplier.address, langOf(lang)) || null },
    {
      label: t('fields.drug_license_no'),
      value:
        pharmacy || supplier.drug_license_no
          ? (supplier.drug_license_no ?? t('supplier.not_given'))
          : null,
    },
    {
      label: t('fields.payment_terms'),
      value:
        supplier.payment_terms_days !== null
          ? t('profile.days', { count: supplier.payment_terms_days })
          : null,
    },
    {
      label: t('fields.lead_time'),
      value:
        supplier.lead_time_days != null
          ? t('profile.days', { count: supplier.lead_time_days })
          : null,
    },
    {
      label: t('profile.opening'),
      value:
        supplier.opening_balance_paise === 0
          ? null
          : `${formatMoney(Math.abs(supplier.opening_balance_paise))} · ${
              supplier.opening_balance_paise > 0 ? t('balance.to_pay') : t('balance.advance')
            }`,
    },
    { label: t('fields.code'), value: supplier.code },
    { label: t('fields.notes'), value: supplier.notes },
    { label: t('profile.supplier_since'), value: formatDate(supplier.created_at) },
  ]
  const bankRows: { label: string; value: ReactNode }[] = [
    { label: t('fields.account_name'), value: bank.account_name },
    {
      label: t('fields.account_number'),
      value: bank.account_no_last4 ? (
        <span className="font-mono">•••• {bank.account_no_last4}</span>
      ) : null,
    },
    {
      label: t('fields.ifsc'),
      value: bank.ifsc ? (
        <span className="inline-flex items-center gap-1 font-mono">
          {bank.ifsc}
          <CopyButton value={bank.ifsc} />
        </span>
      ) : null,
    },
    { label: t('fields.bank_name'), value: bank.bank_name },
    {
      label: t('fields.upi_vpa'),
      value: supplier.upi_vpa ? (
        <span className="inline-flex items-center gap-1 font-mono">
          {supplier.upi_vpa}
          <CopyButton value={supplier.upi_vpa} />
        </span>
      ) : null,
    },
  ]
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <DetailCard
        title={t('profile.details')}
        rows={rows}
        action={
          canWrite ? (
            <Button variant="outline" size="sm" leftIcon={<Pencil />} onClick={onEdit}>
              {t('common:actions.edit')}
            </Button>
          ) : null
        }
      />
      <DetailCard title={t('supplier.bank_title')} rows={bankRows} empty={t('supplier.no_bank')} />
    </div>
  )
}

function DetailCard({
  title,
  rows,
  action,
  empty,
}: {
  title: string
  rows: { label: string; value: ReactNode }[]
  action?: ReactNode
  empty?: string
}) {
  const visible = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== '')
  return (
    <Card className="content-start">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>
        {visible.length === 0 && empty ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <dl className="grid text-sm">
            {visible.map((r) => (
              <div
                key={r.label}
                className="grid grid-cols-[40%_1fr] gap-3 border-b border-border py-2 last:border-0"
              >
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="min-w-0 break-words">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  )
}
