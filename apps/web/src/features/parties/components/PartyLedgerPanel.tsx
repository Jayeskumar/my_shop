/**
 * Ledger tab of the khata / supplier pages: period presets (all time, this month, last month,
 * this FY, …, custom), opening → closing summary, the statement table, and print (Tamil or
 * English A4), WhatsApp share and CSV download of the same statement.
 */
import { Download, MessageCircle, Printer, Share2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { partiesRoutes, type PartyLedger, type PartyLedgerQuery } from '@kadai/shared/api/parties'
import type { PartyType } from '@kadai/shared/enums'
import type { DateRange } from '@kadai/shared/fy'
import { toWhatsAppNumber } from '@kadai/shared/phone'
import {
  Button,
  DateRangePicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  notify,
} from '@/components/ui'
import { useMe } from '@/lib/auth'
import { copyToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/cn'
import type { DatePresetKey } from '@/lib/date-presets'
import { formatMoney } from '@/lib/format'
import type { Language } from '@/lib/i18n'
import { printHtml } from '@/lib/print'
import { useCustomerLedger, useSupplierLedger } from '../api'
import { downloadStatementCsv } from '../lib/download'
import { langOf } from '../lib/labels'
import { STATEMENT_CSS, statementHtml, statementShareText } from '../lib/statement'
import { BalanceAmount } from './BalanceAmount'
import { PartyLedgerTable } from './PartyLedgerTable'

const PRESETS: readonly DatePresetKey[] = [
  'this_month',
  'last_month',
  'last_30_days',
  'this_fy',
  'last_fy',
]

export interface LedgerParty {
  id: string
  name: string
  phone: string | null
}

export function PartyLedgerPanel({
  partyType,
  party,
}: {
  partyType: PartyType
  party: LedgerParty
}) {
  const [range, setRange] = useState<DateRange | null>(null)
  const query: PartyLedgerQuery = range ? { from: range.from, to: range.to } : {}
  return partyType === 'customer' ? (
    <CustomerLedger party={party} query={query} range={range} onRange={setRange} />
  ) : (
    <SupplierLedger party={party} query={query} range={range} onRange={setRange} />
  )
}

interface LedgerViewProps {
  party: LedgerParty
  query: PartyLedgerQuery
  range: DateRange | null
  onRange: (range: DateRange | null) => void
}

function CustomerLedger({ party, query, range, onRange }: LedgerViewProps) {
  const ledger = useCustomerLedger(party.id, query)
  return (
    <LedgerView
      partyType="customer"
      party={party}
      range={range}
      onRange={onRange}
      ledger={ledger.data?.data}
      loading={ledger.isFetching}
      error={ledger.error}
      onRetry={() => void ledger.refetch()}
      onCsv={(lang) =>
        downloadStatementCsv(partiesRoutes.customerLedger, {
          params: { id: party.id },
          query: { from: query.from, to: query.to },
          lang,
          filename: `khata-${slug(party.name)}.csv`,
        })
      }
    />
  )
}

function SupplierLedger({ party, query, range, onRange }: LedgerViewProps) {
  const ledger = useSupplierLedger(party.id, query)
  return (
    <LedgerView
      partyType="supplier"
      party={party}
      range={range}
      onRange={onRange}
      ledger={ledger.data?.data}
      loading={ledger.isFetching}
      error={ledger.error}
      onRetry={() => void ledger.refetch()}
      onCsv={(lang) =>
        downloadStatementCsv(partiesRoutes.supplierLedger, {
          params: { id: party.id },
          query: { from: query.from, to: query.to },
          lang,
          filename: `supplier-ledger-${slug(party.name)}.csv`,
        })
      }
    />
  )
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'party'
  )
}

function LedgerView({
  partyType,
  party,
  range,
  onRange,
  ledger,
  loading,
  error,
  onRetry,
  onCsv,
}: {
  partyType: PartyType
  party: LedgerParty
  range: DateRange | null
  onRange: (range: DateRange | null) => void
  ledger: PartyLedger | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  onCsv: (lang: Language) => Promise<string>
}) {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const me = useMe()
  const uiLang = langOf(i18n.language)
  const [downloading, setDownloading] = useState(false)

  const print = (lang: Language): void => {
    if (!ledger || !me) return
    const html = statementHtml({ ledger, partyType, lang, tenant: me.tenant })
    void printHtml(html, {
      paper: 'a4',
      css: STATEMENT_CSS,
      title: `${t('statement.file_title')} - ${party.name}`,
    }).catch((e: unknown) => notify.error(e))
  }

  const shareText = (lang: Language): string | null =>
    ledger && me ? statementShareText({ ledger, partyType, lang, tenant: me.tenant }) : null

  const shareWhatsApp = (lang: Language): void => {
    const text = shareText(lang)
    if (!text) return
    const number = party.phone ? toWhatsAppNumber(party.phone) : null
    const url = `https://wa.me/${number ?? ''}?text=${encodeURIComponent(text)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const shareNative = async (lang: Language): Promise<void> => {
    const text = shareText(lang)
    if (!text) return
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text })
        return
      } catch {
        // dismissed or unsupported payload: fall back to copying
      }
    }
    if (await copyToClipboard(text)) notify.success(t('ledger.copied'))
  }

  const csv = (lang: Language): void => {
    setDownloading(true)
    onCsv(lang)
      .catch((e: unknown) => notify.error(e))
      .finally(() => setDownloading(false))
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={range ? 'outline' : 'primary'}
            size="md"
            aria-pressed={!range}
            onClick={() => onRange(null)}
          >
            {t('ledger.all_time')}
          </Button>
          <DateRangePicker
            value={range}
            onChange={(r) => onRange(r)}
            presets={PRESETS}
            className={cn(range && 'border-primary text-primary')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" leftIcon={<Printer />} disabled={!ledger}>
                {t('common:actions.print')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('ledger.print_language')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => print('ta')}>
                {t('ledger.in_tamil')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => print('en')}>
                {t('ledger.in_english')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" leftIcon={<Share2 />} disabled={!ledger}>
                {t('common:actions.share')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('ledger.share_whatsapp')}</DropdownMenuLabel>
              <DropdownMenuItem icon={<MessageCircle />} onSelect={() => shareWhatsApp('ta')}>
                {t('ledger.in_tamil')}
              </DropdownMenuItem>
              <DropdownMenuItem icon={<MessageCircle />} onSelect={() => shareWhatsApp('en')}>
                {t('ledger.in_english')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem icon={<Share2 />} onSelect={() => void shareNative(uiLang)}>
                {t('ledger.share_other')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                leftIcon={<Download />}
                loading={downloading}
                disabled={!ledger}
              >
                {t('ledger.csv')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{t('ledger.csv_language')}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => csv(uiLang)}>
                {uiLang === 'ta' ? t('ledger.in_tamil') : t('ledger.in_english')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => csv(uiLang === 'ta' ? 'en' : 'ta')}>
                {uiLang === 'ta' ? t('ledger.in_english') : t('ledger.in_tamil')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {ledger ? (
        <dl className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface p-3 shadow-card sm:grid-cols-4 sm:p-4">
          <SummaryItem label={t('ledger.opening_balance')}>
            <BalanceAmount
              partyType={partyType}
              balancePaise={ledger.opening_balance_paise}
              showLabel={ledger.opening_balance_paise !== 0}
            />
          </SummaryItem>
          <SummaryItem
            label={
              partyType === 'customer'
                ? t('ledger.col_debit_customer')
                : t('ledger.col_debit_supplier')
            }
          >
            <span className="text-sm font-semibold tabular-nums">
              {formatMoney(ledger.total_debit_paise)}
            </span>
          </SummaryItem>
          <SummaryItem
            label={
              partyType === 'customer'
                ? t('ledger.col_credit_customer')
                : t('ledger.col_credit_supplier')
            }
          >
            <span className="text-sm font-semibold tabular-nums">
              {formatMoney(ledger.total_credit_paise)}
            </span>
          </SummaryItem>
          <SummaryItem label={t('ledger.closing_balance')}>
            <BalanceAmount
              partyType={partyType}
              balancePaise={ledger.closing_balance_paise}
              size="lg"
            />
          </SummaryItem>
        </dl>
      ) : null}

      {ledger?.truncated ? (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
          {t('ledger.truncated')}
        </p>
      ) : null}

      <PartyLedgerTable
        partyType={partyType}
        ledger={ledger}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />
    </div>
  )
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
