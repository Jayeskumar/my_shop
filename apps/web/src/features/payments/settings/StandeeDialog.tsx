/**
 * Counter standee / wall poster with the shop's static UPI QR (no amount — the customer types
 * it): GET /payments/upi-qr for the chosen UPI ID (and store), preview on screen, print on A5 or
 * A4 with the shop name in Tamil and English and "scan with any UPI app".
 */
import { Printer } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PaymentProviderAccount } from '@kadai/shared/api/payments'
import { StorePicker } from '@/components/pickers'
import { Button, Dialog, FormField, RadioGroup, Select, Skeleton, notify } from '@/components/ui'
import { useCurrentStore, useMe } from '@/lib/auth'
import { printHtml } from '@/lib/print'
import { useUpiQr } from '../api'
import { QrCode } from '../components/QrCode'
import { standeeCss, standeeHtml } from '../lib/print-docs'

export function StandeeDialog({
  open,
  onOpenChange,
  accounts,
  initialAccountId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Active upi_vpa accounts. */
  accounts: readonly PaymentProviderAccount[]
  initialAccountId?: string | null
}) {
  if (!open) return null
  return (
    <StandeeBody
      onOpenChange={onOpenChange}
      accounts={accounts}
      initialAccountId={initialAccountId ?? accounts[0]?.id ?? null}
    />
  )
}

function StandeeBody({
  onOpenChange,
  accounts,
  initialAccountId,
}: {
  onOpenChange: (open: boolean) => void
  accounts: readonly PaymentProviderAccount[]
  initialAccountId: string | null
}) {
  const { t } = useTranslation(['payments', 'common'])
  const me = useMe()
  const currentStore = useCurrentStore()
  const [accountId, setAccountId] = useState<string | null>(initialAccountId)
  const account = accounts.find((a) => a.id === accountId) ?? null
  const multiStore = (me?.stores.filter((s) => s.is_active).length ?? 0) > 1
  const [storeId, setStoreId] = useState<string | null>(
    account?.store_id ?? currentStore?.id ?? me?.stores[0]?.id ?? null,
  )
  const [paper, setPaper] = useState<'a5' | 'a4'>('a5')
  const [printing, setPrinting] = useState(false)
  const effectiveStore = account?.store_id ?? storeId
  const qr = useUpiQr(
    {
      ...(accountId ? { provider_account_id: accountId } : {}),
      ...(effectiveStore ? { store_id: effectiveStore } : {}),
    },
    Boolean(accountId),
  )
  const payload = qr.data?.data

  const print = async (): Promise<void> => {
    if (!payload) return
    setPrinting(true)
    try {
      await printHtml(
        standeeHtml({
          shop: payload.shop,
          store: payload.store,
          vpa: payload.vpa,
          payee_name: payload.payee_name,
          upi_uri: payload.upi_uri,
          paper,
        }),
        { paper, css: standeeCss(paper), title: t('standee.print_title') },
      )
    } catch (error) {
      notify.error(error)
    } finally {
      setPrinting(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      size="lg"
      title={t('standee.title')}
      description={t('standee.hint')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.close')}
          </Button>
          <Button
            leftIcon={<Printer />}
            size="lg"
            onClick={() => void print()}
            loading={printing}
            disabled={!payload}
          >
            {t('standee.print', { paper: paper.toUpperCase() })}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="grid content-start gap-4 [&>*]:min-w-0">
          {accounts.length > 1 ? (
            <FormField label={t('fields.vpa')}>
              <Select
                value={accountId}
                onValueChange={setAccountId}
                options={accounts.map((a) => ({
                  value: a.id,
                  label: `${a.display_name} · ${a.vpa ?? ''}`,
                }))}
                aria-label={t('fields.vpa')}
              />
            </FormField>
          ) : null}
          {multiStore && account && account.store_id === null ? (
            <FormField label={t('fields.store')} hint={t('standee.store_hint')}>
              <StorePicker value={storeId} onChange={(id) => setStoreId(id)} clearable={false} />
            </FormField>
          ) : null}
          <FormField label={t('standee.paper')}>
            <RadioGroup
              value={paper}
              onValueChange={(v) => setPaper(v)}
              variant="cards"
              orientation="horizontal"
              aria-label={t('standee.paper')}
              options={[
                { value: 'a5', label: 'A5', description: t('standee.a5_hint') },
                { value: 'a4', label: 'A4', description: t('standee.a4_hint') },
              ]}
            />
          </FormField>
          <p className="text-sm text-muted-foreground">{t('standee.tips')}</p>
        </div>

        <figure
          className="mx-auto flex w-60 flex-col items-center gap-2 rounded-lg border border-border bg-white p-4 text-center text-black shadow-card"
          aria-label={t('standee.preview')}
        >
          {qr.isPending ? (
            <>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="size-40" />
              <Skeleton className="h-4 w-32" />
            </>
          ) : payload ? (
            <>
              <div>
                {payload.shop.name_ta ? (
                  <p className="text-lg font-extrabold leading-tight">{payload.shop.name_ta}</p>
                ) : null}
                <p className="text-sm font-semibold">{payload.shop.name}</p>
              </div>
              <QrCode
                value={payload.upi_uri}
                label={t('standee.qr_label', { vpa: payload.vpa })}
                className="w-40 rounded-xl border-2 border-black p-1.5"
              />
              <p className="text-sm font-bold">{t('print.standee_scan', { lng: 'ta' })}</p>
              <p className="text-xs">{t('print.standee_scan', { lng: 'en' })}</p>
              <p className="rounded border border-dashed border-black px-2 py-0.5 font-mono text-xs font-bold">
                {payload.vpa}
              </p>
            </>
          ) : (
            <p className="py-10 text-sm text-danger">{t('standee.load_failed')}</p>
          )}
        </figure>
      </div>
    </Dialog>
  )
}
