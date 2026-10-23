/**
 * Drill-down of one GSTR-1 section: the documents / rows the section is built from, in the
 * columns of the GST offline tool (invoice and credit-note numbers open the document).
 */
import type {
  Gstr1Invoice,
  Gstr1Note,
  Gstr1Report,
  Gstr1Section,
  HsnRow,
  TaxRow,
} from '@kadai/shared/api/reports'
import { documentPath } from '@kadai/shared/api/identity'
import { milliToDecimalString } from '@kadai/shared/units'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { EmptyState, Money } from '@/components/ui'
import { formatDate, formatNumber } from '@/lib/format'
import { FileCheck2 } from 'lucide-react'
import { posLabel, ratesText, sectionSummary, sumItems } from '../lib/gst'
import { useLang } from '../lib/labels'
import { type SimpleColumn, SimpleTable } from '../components/SimpleTable'

interface InvoiceRow extends Gstr1Invoice {
  ctin: string | null
  receiver_name: string | null
  sums: TaxRow
}

interface NoteRow extends Gstr1Note {
  ctin: string | null
  receiver_name: string | null
  sums: TaxRow
}

function DocLink({ type, id, children }: { type: string; id: string; children: ReactNode }) {
  const path = documentPath(type, id)
  return path ? (
    <Link to={path} className="font-medium text-primary underline-offset-2 hover:underline">
      {children}
    </Link>
  ) : (
    <>{children}</>
  )
}

const money = (p: number) => <Money paise={p} />

export function Gstr1SectionTable({
  report,
  section,
}: {
  report: Gstr1Report
  section: Gstr1Section
}) {
  const { t } = useTranslation('reports')
  const lng = useLang()
  const summary = sectionSummary(report, section)
  const label = t(`gst.sections.${section}`)
  const totalLabel = t('viewer.total')

  const taxColumns = <R extends { sums: TaxRow }>(
    heads: readonly ('igst' | 'cgst' | 'sgst' | 'cess')[],
  ): SimpleColumn<R>[] => [
    {
      key: 'taxable',
      header: t('gst.col.taxable'),
      align: 'right',
      cell: (r) => money(r.sums.taxable_paise),
      total: summary ? money(summary.taxable_paise) : undefined,
    },
    ...heads.map((h): SimpleColumn<R> => ({
      key: h,
      header: t(`gst.col.${h}`),
      align: 'right',
      cell: (r) => money(r.sums[`${h}_paise`]),
      total: summary ? money(summary[`${h}_paise`]) : undefined,
    })),
  ]
  const rowTaxColumns = <R extends TaxRow>(
    heads: readonly ('igst' | 'cgst' | 'sgst' | 'cess')[],
  ): SimpleColumn<R>[] => [
    {
      key: 'taxable',
      header: t('gst.col.taxable'),
      align: 'right',
      cell: (r) => money(r.taxable_paise),
      total: summary ? money(summary.taxable_paise) : undefined,
    },
    ...heads.map((h): SimpleColumn<R> => ({
      key: h,
      header: t(`gst.col.${h}`),
      align: 'right',
      cell: (r) => money(r[`${h}_paise`]),
      total: summary ? money(summary[`${h}_paise`]) : undefined,
    })),
  ]

  const empty = (
    <div className="rounded-xl border border-border bg-surface">
      <EmptyState
        compact
        icon={<FileCheck2 />}
        title={t('gst.section_empty_title', { section: label })}
        description={t('gst.section_empty_hint')}
      />
    </div>
  )

  switch (section) {
    case 'b2b':
    case 'b2cl': {
      const rows: InvoiceRow[] =
        section === 'b2b'
          ? report.b2b.flatMap((p) =>
              p.invoices.map((inv) => ({
                ...inv,
                ctin: p.ctin,
                receiver_name: p.receiver_name,
                sums: sumItems(inv.items),
              })),
            )
          : report.b2cl.flatMap((p) =>
              p.invoices.map((inv) => ({
                ...inv,
                ctin: null,
                receiver_name: inv.customer_name,
                sums: sumItems(inv.items),
              })),
            )
      if (!rows.length) return empty
      const columns: SimpleColumn<InvoiceRow>[] = [
        {
          key: 'number',
          header: t('gst.col.invoice'),
          mobile: 'title',
          cell: (r) => (
            <DocLink type="sales_invoice" id={r.invoice_id}>
              {r.number}
            </DocLink>
          ),
        },
        {
          key: 'date',
          header: t('gst.col.date'),
          className: 'whitespace-nowrap',
          cell: (r) => formatDate(r.date),
        },
        ...(section === 'b2b'
          ? [
              {
                key: 'ctin',
                header: t('gst.col.gstin'),
                mobile: 'subtitle' as const,
                cell: (r: InvoiceRow) => (
                  <span className="font-mono text-xs">
                    {r.ctin}
                    {r.receiver_name ? (
                      <span className="block font-sans text-muted-foreground">
                        {r.receiver_name}
                      </span>
                    ) : null}
                  </span>
                ),
              },
            ]
          : []),
        { key: 'pos', header: t('gst.col.pos'), cell: (r) => posLabel(r.place_of_supply, lng) },
        {
          key: 'rates',
          header: t('gst.col.rate'),
          className: 'whitespace-nowrap',
          cell: (r) => ratesText(r.items),
        },
        {
          key: 'value',
          header: t('gst.col.invoice_value'),
          align: 'right',
          cell: (r) => money(r.value_paise),
          total: summary ? money(summary.value_paise) : undefined,
        },
        ...taxColumns<InvoiceRow>(
          section === 'b2b' ? ['igst', 'cgst', 'sgst', 'cess'] : ['igst', 'cess'],
        ),
      ]
      return (
        <SimpleTable
          label={label}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.invoice_id}
          totalLabel={totalLabel}
        />
      )
    }
    case 'b2cs': {
      if (!report.b2cs.length) return empty
      type Row = Gstr1Report['b2cs'][number]
      const columns: SimpleColumn<Row>[] = [
        {
          key: 'pos',
          header: t('gst.col.pos'),
          mobile: 'title',
          cell: (r) => posLabel(r.place_of_supply, lng),
        },
        {
          key: 'supply',
          header: t('gst.col.supply_type'),
          mobile: 'subtitle',
          cell: (r) => t(r.supply_type === 'INTER' ? 'gst.inter_state' : 'gst.intra_state'),
        },
        { key: 'rate', header: t('gst.col.rate'), cell: (r) => `${r.rate_bp / 100}%` },
        ...rowTaxColumns<Row>(['igst', 'cgst', 'sgst', 'cess']),
      ]
      return (
        <SimpleTable
          label={label}
          columns={columns}
          rows={report.b2cs}
          rowKey={(r) => `${r.supply_type}-${r.place_of_supply}-${r.rate_bp}`}
          totalLabel={totalLabel}
        />
      )
    }
    case 'cdnr':
    case 'cdnur': {
      const rows: NoteRow[] =
        section === 'cdnr'
          ? report.cdnr.flatMap((p) =>
              p.notes.map((n) => ({
                ...n,
                ctin: p.ctin,
                receiver_name: p.receiver_name,
                sums: sumItems(n.items),
              })),
            )
          : report.cdnur.map((n) => ({
              ...n,
              ctin: null,
              receiver_name: n.customer_name,
              sums: sumItems(n.items),
            }))
      if (!rows.length) return empty
      const columns: SimpleColumn<NoteRow>[] = [
        {
          key: 'number',
          header: t('gst.col.note'),
          mobile: 'title',
          cell: (r) => (
            <DocLink type="credit_note" id={r.credit_note_id}>
              {r.number}
            </DocLink>
          ),
        },
        {
          key: 'date',
          header: t('gst.col.date'),
          className: 'whitespace-nowrap',
          cell: (r) => formatDate(r.date),
        },
        {
          key: 'party',
          header: section === 'cdnr' ? t('gst.col.gstin') : t('gst.col.customer'),
          mobile: 'subtitle',
          cell: (r) => (
            <span className={r.ctin ? 'font-mono text-xs' : undefined}>
              {r.ctin ?? r.receiver_name ?? '—'}
              {r.ctin && r.receiver_name ? (
                <span className="block font-sans text-muted-foreground">{r.receiver_name}</span>
              ) : null}
            </span>
          ),
        },
        {
          key: 'original',
          header: t('gst.col.original_invoice'),
          cell: (r) =>
            r.original_invoice_number
              ? `${r.original_invoice_number}${r.original_invoice_date ? ` · ${formatDate(r.original_invoice_date)}` : ''}`
              : '—',
        },
        {
          key: 'value',
          header: t('gst.col.note_value'),
          align: 'right',
          cell: (r) => money(r.value_paise),
          total: summary ? money(summary.value_paise) : undefined,
        },
        ...taxColumns<NoteRow>(
          section === 'cdnr' ? ['igst', 'cgst', 'sgst', 'cess'] : ['igst', 'cess'],
        ),
      ]
      return (
        <SimpleTable
          label={label}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.credit_note_id}
          totalLabel={totalLabel}
        />
      )
    }
    case 'nil': {
      const rows = (
        [
          ['inter_b2b', report.nil.inter_b2b],
          ['intra_b2b', report.nil.intra_b2b],
          ['inter_b2c', report.nil.inter_b2c],
          ['intra_b2c', report.nil.intra_b2c],
        ] as const
      ).map(([key, r]) => ({ key, ...r }))
      type Row = (typeof rows)[number]
      const columns: SimpleColumn<Row>[] = [
        {
          key: 'desc',
          header: t('gst.col.description'),
          mobile: 'title',
          cell: (r) => t(`gst.nil.${r.key}`),
        },
        {
          key: 'nil',
          header: t('gst.col.nil_rated'),
          align: 'right',
          cell: (r) => money(r.nil_rated_paise),
        },
        {
          key: 'exempt',
          header: t('gst.col.exempt'),
          align: 'right',
          cell: (r) => money(r.exempt_paise),
        },
        {
          key: 'non_gst',
          header: t('gst.col.non_gst'),
          align: 'right',
          cell: (r) => money(r.non_gst_paise),
        },
      ]
      return <SimpleTable label={label} columns={columns} rows={rows} rowKey={(r) => r.key} />
    }
    case 'hsn_b2b':
    case 'hsn_b2c': {
      const rows = section === 'hsn_b2b' ? report.hsn.b2b : report.hsn.b2c
      if (!rows.length) return empty
      return <HsnTable rows={rows} label={label} totalsFrom={summary} />
    }
    case 'doc_issue': {
      const rows = report.doc_issue.flatMap((d) =>
        d.series.map((s) => ({ ...s, doc_num: d.doc_num, doc_type: d.doc_type })),
      )
      if (!rows.length) return empty
      type Row = (typeof rows)[number]
      const columns: SimpleColumn<Row>[] = [
        {
          key: 'nature',
          header: t('gst.col.nature'),
          mobile: 'title',
          cell: (r) => t(`gst.doc_types.${r.doc_num}`),
        },
        {
          key: 'from',
          header: t('gst.col.from'),
          mobile: 'subtitle',
          cell: (r) => (
            <span className="font-mono text-xs">
              {r.from} → {r.to}
            </span>
          ),
        },
        {
          key: 'total',
          header: t('gst.col.total_docs'),
          align: 'right',
          cell: (r) => formatNumber(r.total),
        },
        {
          key: 'cancelled',
          header: t('gst.col.cancelled'),
          align: 'right',
          cell: (r) => formatNumber(r.cancelled),
        },
        {
          key: 'net',
          header: t('gst.col.net_issued'),
          align: 'right',
          cell: (r) => formatNumber(r.net_issued),
        },
      ]
      return (
        <SimpleTable
          label={label}
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.doc_num}-${r.prefix}-${r.from}`}
        />
      )
    }
  }
}

/** HSN-wise summary (GSTR-1 table 12) — shared by the section drill-down and the HSN tab. */
export function HsnTable({
  rows,
  label,
  totalsFrom,
}: {
  rows: readonly HsnRow[]
  label: string
  totalsFrom?: TaxRow | null
}) {
  const { t } = useTranslation('reports')
  const columns: SimpleColumn<HsnRow>[] = [
    {
      key: 'hsn',
      header: t('gst.col.hsn'),
      mobile: 'title',
      cell: (r) =>
        r.hsn_code ? (
          <span className="font-mono">{r.hsn_code}</span>
        ) : (
          <span className="text-danger">{t('gst.no_hsn')}</span>
        ),
    },
    {
      key: 'desc',
      header: t('gst.col.description'),
      mobile: 'subtitle',
      cell: (r) => r.description ?? '—',
    },
    { key: 'uqc', header: t('gst.col.uqc'), cell: (r) => r.uqc },
    {
      key: 'qty',
      header: t('gst.col.qty'),
      align: 'right',
      cell: (r) => milliToDecimalString(r.qty_milli, true),
    },
    { key: 'rate', header: t('gst.col.rate'), align: 'right', cell: (r) => `${r.rate_bp / 100}%` },
    {
      key: 'taxable',
      header: t('gst.col.taxable'),
      align: 'right',
      cell: (r) => money(r.taxable_paise),
      total: totalsFrom ? money(totalsFrom.taxable_paise) : undefined,
    },
    ...(['igst', 'cgst', 'sgst', 'cess'] as const).map((h): SimpleColumn<HsnRow> => ({
      key: h,
      header: t(`gst.col.${h}`),
      align: 'right',
      cell: (r) => money(r[`${h}_paise`]),
      total: totalsFrom ? money(totalsFrom[`${h}_paise`]) : undefined,
    })),
    {
      key: 'total',
      header: t('gst.col.total_value'),
      align: 'right',
      cell: (r) => money(r.total_value_paise),
    },
  ]
  return (
    <SimpleTable
      label={label}
      columns={columns}
      rows={rows}
      rowKey={(r, i) => `${r.hsn_code ?? 'none'}-${r.uqc}-${r.rate_bp}-${i}`}
      totalLabel={t('viewer.total')}
      dense
    />
  )
}
