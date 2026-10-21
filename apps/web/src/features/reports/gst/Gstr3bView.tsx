/**
 * GSTR-3B summary laid out like the form: 3.1 outward supplies, 3.2 inter-state supplies to
 * unregistered persons, 4 eligible ITC, 5 exempt inward supplies and 6.1 payment of tax (ITC
 * utilised in the rule-88A order, cash to pay, credit carried forward).
 */
import type { Gstr3bReport, TaxHeads, TaxRow } from '@kadai/shared/api/reports'
import { Banknote, Wallet } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Money } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { posLabel } from '../lib/gst'
import { useLang } from '../lib/labels'
import { type SimpleColumn, SimpleTable } from '../components/SimpleTable'

const HEADS = ['igst', 'cgst', 'sgst', 'cess'] as const

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`g3b-${id}`} className="grid grid-cols-1 gap-2">
      <h3 id={`g3b-${id}`} className="text-base font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

const money = (p: number) => <Money paise={p} />

export function Gstr3bView({ report }: { report: Gstr3bReport }) {
  const { t } = useTranslation('reports')
  const lng = useLang()

  const outwardRows = (
    [
      ['a', report.outward.taxable],
      ['b', report.outward.zero_rated],
      ['c', report.outward.nil_exempt],
      ['d', report.outward.inward_rcm],
      ['e', report.outward.non_gst],
    ] as const
  ).map(([key, row]) => ({ key, ...row }))
  type OutRow = TaxRow & { key: 'a' | 'b' | 'c' | 'd' | 'e' }
  const outwardColumns: SimpleColumn<OutRow>[] = [
    {
      key: 'nature',
      header: t('gstr3b.col.nature'),
      mobile: 'title',
      className: 'min-w-64 whitespace-normal',
      cell: (r) => (
        <span>
          <span className="me-1 font-semibold">({r.key})</span>
          {t(`gstr3b.outward.${r.key}`)}
        </span>
      ),
    },
    {
      key: 'taxable',
      header: t('gstr3b.col.taxable'),
      align: 'right',
      cell: (r) => money(r.taxable_paise),
    },
    ...HEADS.map((h): SimpleColumn<OutRow> => ({
      key: h,
      header: t(`gstr3b.col.${h}`),
      align: 'right',
      cell: (r) => money(r[`${h}_paise`]),
    })),
  ]

  type ItcKey = 'A' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'B' | 'B1' | 'B2' | 'C' | 'D' | 'D1' | 'D2'
  type ItcRow = TaxHeads & { key: ItcKey; kind: 'head' | 'row' | 'net' }
  const itc = report.itc
  const itcRows: ItcRow[] = [
    { key: 'A', kind: 'head', igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 },
    { key: 'A1', kind: 'row', ...itc.import_goods },
    { key: 'A2', kind: 'row', ...itc.import_services },
    { key: 'A3', kind: 'row', ...itc.inward_rcm },
    { key: 'A4', kind: 'row', ...itc.isd },
    { key: 'A5', kind: 'row', ...itc.all_other },
    { key: 'B', kind: 'head', igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 },
    { key: 'B1', kind: 'row', ...itc.reversed_rules },
    { key: 'B2', kind: 'row', ...itc.reversed_others },
    { key: 'C', kind: 'net', ...itc.net },
    { key: 'D', kind: 'head', igst_paise: 0, cgst_paise: 0, sgst_paise: 0, cess_paise: 0 },
    { key: 'D1', kind: 'row', ...itc.ineligible_16_4 },
    { key: 'D2', kind: 'row', ...itc.ineligible_pos },
  ]
  const itcColumns: SimpleColumn<ItcRow>[] = [
    {
      key: 'details',
      header: t('gstr3b.col.details'),
      mobile: 'title',
      className: 'min-w-64 whitespace-normal',
      cell: (r) => (
        <span className={r.kind === 'row' ? 'ps-4' : 'font-semibold'}>
          {t(`gstr3b.itc.${r.key}`)}
        </span>
      ),
    },
    ...HEADS.map((h): SimpleColumn<ItcRow> => ({
      key: h,
      header: t(`gstr3b.col.${h}`),
      align: 'right',
      mobile: 'value',
      cell: (r) => (r.kind === 'head' ? null : money(r[`${h}_paise`])),
    })),
  ]

  const exemptRows = [
    { key: 'composition_exempt_nil', ...report.exempt_inward.composition_exempt_nil },
    { key: 'non_gst', ...report.exempt_inward.non_gst },
  ]
  type ExRow = (typeof exemptRows)[number]
  const exemptColumns: SimpleColumn<ExRow>[] = [
    {
      key: 'nature',
      header: t('gstr3b.col.nature'),
      mobile: 'title',
      className: 'min-w-64 whitespace-normal',
      cell: (r) => t(`gstr3b.exempt.${r.key as 'composition_exempt_nil' | 'non_gst'}`),
    },
    {
      key: 'inter',
      header: t('gstr3b.col.inter'),
      align: 'right',
      cell: (r) => money(r.inter_paise),
    },
    {
      key: 'intra',
      header: t('gstr3b.col.intra'),
      align: 'right',
      cell: (r) => money(r.intra_paise),
    },
  ]

  type PayRow = Gstr3bReport['payment']['rows'][number]
  const paymentColumns: SimpleColumn<PayRow>[] = [
    {
      key: 'head',
      header: t('gstr3b.col.description'),
      mobile: 'title',
      className: 'whitespace-nowrap',
      cell: (r) => <span className="font-semibold">{t(`gstr3b.heads.${r.head}`)}</span>,
    },
    {
      key: 'payable',
      header: t('gstr3b.col.payable'),
      align: 'right',
      cell: (r) => money(r.payable_paise),
    },
    ...HEADS.map((h): SimpleColumn<PayRow> => ({
      key: `itc_${h}`,
      header: t('gstr3b.col.paid_itc', { head: t(`gst.col.${h}`) }),
      align: 'right',
      cell: (r) => money(r.paid_itc[`${h}_paise`]),
    })),
    {
      key: 'cash',
      header: t('gstr3b.col.paid_cash'),
      align: 'right',
      cell: (r) => money(r.paid_cash_paise),
    },
    {
      key: 'rcm',
      header: t('gstr3b.col.rcm'),
      align: 'right',
      cell: (r) => money(r.rcm_payable_paise),
    },
  ]

  const balance = report.payment.itc_balance
  const balanceTotal =
    balance.igst_paise + balance.cgst_paise + balance.sgst_paise + balance.cess_paise

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="flex items-center gap-3 p-4">
          <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
            <Banknote className="size-5" aria-hidden />
          </span>
          <div>
            <p className="text-sm text-muted-foreground">{t('gstr3b.cash_to_pay')}</p>
            <p className="text-2xl font-bold tabular-nums">
              <Money paise={report.payment.cash_total_paise} />
            </p>
          </div>
        </Card>
        <Card className="flex items-center gap-3 p-4">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-soft-foreground">
            <Wallet className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{t('gstr3b.itc_carried')}</p>
            <p className="text-2xl font-bold tabular-nums">
              <Money paise={balanceTotal} />
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {HEADS.map(
                (h) =>
                  `${t(`gstr3b.col.${h}`)} ${formatMoney(balance[`${h}_paise`], { decimals: 0 })}`,
              ).join(' · ')}
            </p>
          </div>
        </Card>
      </div>

      <Block id="31" title={t('gstr3b.sections.s31')}>
        <SimpleTable
          label={t('gstr3b.sections.s31')}
          columns={outwardColumns}
          rows={outwardRows}
          rowKey={(r) => r.key}
        />
      </Block>

      <Block id="32" title={t('gstr3b.sections.s32')}>
        {report.inter_state_unregistered.length ? (
          <SimpleTable
            label={t('gstr3b.sections.s32')}
            columns={[
              {
                key: 'pos',
                header: t('gstr3b.col.pos'),
                mobile: 'title',
                cell: (r) => posLabel(r.place_of_supply, lng),
              },
              {
                key: 'taxable',
                header: t('gstr3b.col.taxable'),
                align: 'right',
                cell: (r) => money(r.taxable_paise),
              },
              {
                key: 'igst',
                header: t('gstr3b.col.igst'),
                align: 'right',
                cell: (r) => money(r.igst_paise),
              },
            ]}
            rows={report.inter_state_unregistered}
            rowKey={(r) => r.place_of_supply}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t('gstr3b.none_32')}
          </p>
        )}
      </Block>

      <Block id="4" title={t('gstr3b.sections.s4')}>
        <SimpleTable
          label={t('gstr3b.sections.s4')}
          columns={itcColumns}
          rows={itcRows}
          rowKey={(r) => r.key}
          dense
        />
      </Block>

      <Block id="5" title={t('gstr3b.sections.s5')}>
        <SimpleTable
          label={t('gstr3b.sections.s5')}
          columns={exemptColumns}
          rows={exemptRows}
          rowKey={(r) => r.key}
        />
      </Block>

      <Block id="61" title={t('gstr3b.sections.s61')}>
        <SimpleTable
          label={t('gstr3b.sections.s61')}
          columns={paymentColumns}
          rows={report.payment.rows}
          rowKey={(r) => r.head}
          dense
        />
      </Block>

      <p className="text-xs text-muted-foreground">
        {t('gstr3b.sources', {
          invoices: report.sources.sales_invoices,
          credit_notes: report.sources.credit_notes,
          bills: report.sources.purchase_bills,
          debit_notes: report.sources.debit_notes,
          expenses: report.sources.expenses,
        })}
      </p>
    </div>
  )
}
