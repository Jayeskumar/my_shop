/**
 * Print templates (React → static HTML): thermal 58 / 80 mm receipts and the A4 GST tax invoice
 * for invoices, estimates and credit notes, from the print model contract (SalesPrintModel —
 * GET /sales/invoices/:id/print, GET /sales/credit-notes/:id/print, or built locally for offline
 * bills). Bilingual, HSN / rate tax tables, amount in words in both languages, UPI QR for the
 * due, composition declaration, pharmacy rx block and drug licence numbers.
 */
import { Fragment, type ReactNode } from 'react'
import type { SalesPrintModel } from '@kadai/shared/api/sales'
import {
  type Bi,
  biText,
  date,
  label,
  money,
  moneyPlain,
  nameLines,
  pct,
  primaryText,
} from './labels'
import { qrSvg } from './qr'

type Model = SalesPrintModel
type Line = Model['lines'][number]

function Qr({ text, size, caption }: { text: string; size: string; caption?: string }) {
  return (
    <div className="qr">
      <div className="qr-img" dangerouslySetInnerHTML={{ __html: qrSvg(text, { size }) }} />
      {caption ? <div className="small center">{caption}</div> : null}
    </div>
  )
}

function Row({
  left,
  right,
  className,
}: {
  left: ReactNode
  right: ReactNode
  className?: string
}) {
  return (
    <tr className={className}>
      <td>{left}</td>
      <td className="num">{right}</td>
    </tr>
  )
}

function FullRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <tr className={className}>
      <td colSpan={2}>{children}</td>
    </tr>
  )
}

function BiLabel({ model, text }: { model: Model; text: Bi }) {
  return <>{biText(model, text)}</>
}

function lineChips(model: Model, l: Line): string[] {
  const out: string[] = []
  if (l.variant_text) out.push(l.variant_text)
  if (l.batch_no) out.push(`${primaryText(model, label('batch'))} ${l.batch_no}`)
  if (l.expiry_date) out.push(`${primaryText(model, label('expiry'))} ${date(l.expiry_date)}`)
  if (l.schedule && l.schedule !== 'OTC')
    out.push(primaryText(model, label('schedule', { schedule: l.schedule })))
  if (model.flags.show_hsn && l.hsn_code) out.push(`HSN ${l.hsn_code}`)
  if (l.serial_numbers.length) out.push(`S/N ${l.serial_numbers.join(', ')}`)
  return out
}

function SellerHeader({ model, compact }: { model: Model; compact: boolean }) {
  const s = model.seller
  const names = nameLines(model, s.name, s.name_ta)
  return (
    <header className="seller center">
      {s.logo_url ? <img className="logo" src={s.logo_url} alt="" /> : null}
      <div className="shop">{names.primary}</div>
      {names.secondary ? <div className="shop-2">{names.secondary}</div> : null}
      {s.legal_name && s.legal_name !== s.name && !compact ? (
        <div className="small">{s.legal_name}</div>
      ) : null}
      {s.address_lines.map((a) => (
        <div key={a} className="small">
          {a}
        </div>
      ))}
      {s.phone ? (
        <div className="small">
          {biText(model, label('phone'))}: {s.phone}
        </div>
      ) : null}
      {s.gstin ? <div className="small bold">GSTIN: {s.gstin}</div> : null}
      {s.fssai_number ? <div className="small">FSSAI: {s.fssai_number}</div> : null}
      {s.drug_license_numbers ? (
        <div className="small">
          {biText(model, label('drug_licence'))}: {s.drug_license_numbers}
        </div>
      ) : null}
    </header>
  )
}

function Rx({ model }: { model: Model }) {
  const rx = model.rx
  if (!rx) return null
  return (
    <section className="rx">
      <div className="bold">{biText(model, label('rx'))}</div>
      <div>
        {biText(model, label('doctor'))}: {rx.doctor_name}
        {rx.doctor_reg_no ? ` (${primaryText(model, label('reg_no'))} ${rx.doctor_reg_no})` : ''}
      </div>
      <div>
        {biText(model, label('patient'))}: {rx.patient_name}
        {rx.patient_age !== null ? `, ${primaryText(model, label('age'))} ${rx.patient_age}` : ''}
      </div>
      {rx.patient_address ? <div className="small">{rx.patient_address}</div> : null}
      {rx.rx_date ? (
        <div className="small">
          {primaryText(model, label('rx_date'))}: {date(rx.rx_date)}
        </div>
      ) : null}
    </section>
  )
}

function Savings({ model }: { model: Model }) {
  if (!model.savings || model.savings.total_paise <= 0) return null
  return (
    <div className="savings center">
      {biText(model, label('you_saved', { amount: money(model.savings.total_paise) }))}
    </div>
  )
}

function Loyalty({ model }: { model: Model }) {
  const l = model.loyalty
  if (!l) return null
  return (
    <div className="small center">
      {l.points_earned > 0
        ? biText(model, label('points_earned', { points: l.points_earned }))
        : null}
      {l.points_redeemed > 0 ? (
        <div>
          {biText(
            model,
            label('points_redeemed', { points: l.points_redeemed, amount: money(l.redeem_paise) }),
          )}
        </div>
      ) : null}
      {l.balance_points !== null ? (
        <div>{biText(model, label('points_balance', { points: l.balance_points }))}</div>
      ) : null}
    </div>
  )
}

function DocumentMeta({ model }: { model: Model }) {
  const d = model.document
  return (
    <table className="meta">
      <tbody>
        <FullRow>
          {biText(model, model.kind === 'credit_note' ? label('note_no') : label('bill_no'))}:{' '}
          <b className="nowrap">{d.number ?? primaryText(model, label('provisional_no'))}</b>
        </FullRow>
        <Row
          left={`${date(d.date)} ${d.time}`}
          right={
            d.register_code ? `${primaryText(model, label('counter'))}: ${d.register_code}` : ''
          }
        />
        {d.cashier_name ? (
          <FullRow>{`${primaryText(model, label('cashier'))}: ${d.cashier_name}`}</FullRow>
        ) : null}
        {d.original_invoice ? (
          <Row
            left={`${primaryText(model, label('original_invoice'))}: ${d.original_invoice.number ?? '—'}`}
            right={date(d.original_invoice.date)}
          />
        ) : null}
        {d.reason ? (
          <Row
            left={`${primaryText(model, label('reason'))}: ${primaryText(model, d.reason)}`}
            right=""
          />
        ) : null}
        {d.valid_until ? (
          <Row left={primaryText(model, label('valid_until'))} right={date(d.valid_until)} />
        ) : null}
      </tbody>
    </table>
  )
}

function Buyer({ model }: { model: Model }) {
  const b = model.buyer
  if (!b) {
    return <div className="small">{biText(model, label('walk_in'))}</div>
  }
  return (
    <div className="buyer small">
      <div>
        {biText(model, label('customer'))}: <b>{b.name}</b>
        {b.phone ? ` · ${b.phone}` : ''}
      </div>
      {b.gstin ? <div>GSTIN: {b.gstin}</div> : null}
      {b.address_lines.length ? <div>{b.address_lines.join(', ')}</div> : null}
    </div>
  )
}

function PaymentsBlock({ model }: { model: Model }) {
  // The cash row shows the cash handed over (₹1,000), the change row what went back (₹209).
  const cashRow = model.payments.map((p) => p.method).lastIndexOf('cash')
  const rows: ReactNode[] = model.payments.map((p, i) => (
    <Row
      key={`${p.method}-${i}`}
      left={`${biText(model, p.label)}${p.reference ? ` (${p.reference})` : ''}`}
      right={money(p.amount_paise + (i === cashRow ? model.change_paise : 0))}
    />
  ))
  return (
    <table className="totals">
      <tbody>
        {rows}
        {model.change_paise > 0 ? (
          <Row
            className="bold"
            left={biText(model, label('change'))}
            right={money(model.change_paise)}
          />
        ) : null}
        {model.due_paise > 0 ? (
          <Row className="bold" left={biText(model, label('due'))} right={money(model.due_paise)} />
        ) : null}
        {model.document.due_date && model.due_paise > 0 ? (
          <Row left={primaryText(model, label('due_date'))} right={date(model.document.due_date)} />
        ) : null}
        {model.returned_paise > 0 ? (
          <Row left={biText(model, label('returned'))} right={money(model.returned_paise)} />
        ) : null}
        {model.customer_balance_paise !== null && model.customer_balance_paise !== 0 ? (
          <Row
            left={biText(
              model,
              model.customer_balance_paise > 0 ? label('khata_balance') : label('advance'),
            )}
            right={money(Math.abs(model.customer_balance_paise))}
          />
        ) : null}
        {model.settlement ? (
          <Row
            className="bold"
            left={`${primaryText(model, label('settlement'))}: ${biText(model, model.settlement.label)}`}
            right={money(model.settlement.amount_paise)}
          />
        ) : null}
      </tbody>
    </table>
  )
}

function TaxSummary({ model, compact }: { model: Model; compact: boolean }) {
  if (model.tax_breakup.length === 0 || model.doc_type === 'bill_of_supply') return null
  const inter = model.document.is_interstate
  const labels = model.tax_labels
  return (
    <table className="tax">
      <thead>
        <tr>
          <th>{primaryText(model, label('gst_rate'))}</th>
          {compact ? null : <th className="num">{primaryText(model, label('taxable'))}</th>}
          {inter ? (
            <th className="num">{labels.igst}</th>
          ) : (
            <>
              <th className="num">{labels.cgst}</th>
              <th className="num">{labels.sgst}</th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {model.tax_breakup.map((r) => (
          <tr key={r.gst_rate_bp}>
            <td>{pct(r.gst_rate_bp)}</td>
            {compact ? null : <td className="num">{moneyPlain(r.taxable_paise)}</td>}
            {inter ? (
              <td className="num">{moneyPlain(r.igst_paise)}</td>
            ) : (
              <>
                <td className="num">{moneyPlain(r.cgst_paise)}</td>
                <td className="num">{moneyPlain(r.sgst_paise)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Footer({ model }: { model: Model }) {
  const f = model.footer
  return (
    <footer className="footer center">
      {model.composition_declaration ? (
        <div className="small bold">{biText(model, model.composition_declaration)}</div>
      ) : null}
      <div>{primaryText(model, { en: f.text_en, ta: f.text_ta })}</div>
      {model.flags.bilingual && f.text_en !== f.text_ta ? (
        <div className="small">{model.locale.primary === 'ta' ? f.text_en : f.text_ta}</div>
      ) : null}
      {f.terms ? <div className="small terms">{f.terms}</div> : null}
    </footer>
  )
}

// =============================================================================================
// Thermal receipt
// =============================================================================================

function lineMrp(model: Model, l: Line): string | null {
  return model.flags.show_mrp && l.mrp_paise !== null && l.mrp_paise > l.rate_paise
    ? `MRP ${moneyPlain(l.mrp_paise)}`
    : null
}

function LineDetails({ model, l }: { model: Model; l: Line }) {
  const names = nameLines(model, l.name, l.name_ta)
  const chips = lineChips(model, l)
  return (
    <>
      {names.secondary ? <div className="small">{names.secondary}</div> : null}
      {chips.length ? <div className="small chips">{chips.join(' · ')}</div> : null}
      {l.note ? <div className="small">“{l.note}”</div> : null}
      {l.discount_paise > 0 ? (
        <div className="small">
          {primaryText(model, label('discount'))} −{moneyPlain(l.discount_paise)}
        </div>
      ) : null}
    </>
  )
}

/** 58 mm: name and details, "qty × rate (MRP)" below, amount on the right. */
function CompactItems({ model }: { model: Model }) {
  return (
    <table className="items">
      <thead>
        <tr>
          <th>{biText(model, label('item'))}</th>
          <th className="num">{primaryText(model, label('amount'))}</th>
        </tr>
      </thead>
      <tbody>
        {model.lines.map((l) => {
          const mrp = lineMrp(model, l)
          return (
            <tr key={l.line_no} className="item">
              <td>
                <div className="name">
                  {l.line_no}. {nameLines(model, l.name, l.name_ta).primary}
                </div>
                <LineDetails model={model} l={l} />
                <div className="small">
                  {primaryText(model, l.qty_display)} × {moneyPlain(l.rate_paise)}
                  {mrp ? ` (${mrp})` : ''}
                </div>
              </td>
              <td className="num top">{moneyPlain(l.total_paise)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * 80 mm: the item name across the full width (long Tamil names stay on one line), then the
 * details on the left and qty / rate / amount in columns.
 */
function WideItems({ model }: { model: Model }) {
  return (
    <table className="items wide">
      <thead>
        <tr>
          <th>{biText(model, label('item'))}</th>
          <th className="num">{primaryText(model, label('qty'))}</th>
          <th className="num">{primaryText(model, label('rate'))}</th>
          <th className="num">{primaryText(model, label('amount'))}</th>
        </tr>
      </thead>
      <tbody>
        {model.lines.map((l) => {
          const mrp = lineMrp(model, l)
          return (
            <Fragment key={l.line_no}>
              <tr className="item">
                <td colSpan={4} className="name">
                  {l.line_no}. {nameLines(model, l.name, l.name_ta).primary}
                </td>
              </tr>
              <tr className="item-nums">
                <td>
                  <LineDetails model={model} l={l} />
                  {mrp ? <div className="small">{mrp}</div> : null}
                </td>
                <td className="num top">{primaryText(model, l.qty_display)}</td>
                <td className="num top">{moneyPlain(l.rate_paise)}</td>
                <td className="num top bold">{moneyPlain(l.total_paise)}</td>
              </tr>
            </Fragment>
          )
        })}
      </tbody>
    </table>
  )
}

export function ThermalReceipt({ model, width }: { model: Model; width: 58 | 80 }) {
  const compact = width === 58
  const t = model.totals
  const showDiscount = t.discount_paise > 0
  return (
    <div className={`receipt w${width}`}>
      <SellerHeader model={model} compact={compact} />
      <div className="title center">
        <BiLabel model={model} text={model.title} />
      </div>
      {model.document.cancelled ? (
        <div className="stamp center">{biText(model, label('cancelled'))}</div>
      ) : null}
      {model.document.number === null ? (
        <div className="small center">{biText(model, label('provisional'))}</div>
      ) : null}
      <hr />
      <DocumentMeta model={model} />
      <Buyer model={model} />
      <hr />
      {compact ? <CompactItems model={model} /> : <WideItems model={model} />}
      <hr />
      <table className="totals">
        <tbody>
          <Row
            left={biText(model, label('items_count', { count: t.item_count }))}
            right={showDiscount ? money(t.gross_paise) : ''}
          />
          {showDiscount ? (
            <Row left={biText(model, label('discount'))} right={`−${money(t.discount_paise)}`} />
          ) : null}
          {model.doc_type !== 'bill_of_supply' && t.tax_paise > 0 ? (
            <Row left={biText(model, label('taxable'))} right={money(t.taxable_paise)} />
          ) : null}
          {model.doc_type !== 'bill_of_supply' && t.tax_paise > 0 ? (
            <Row left={biText(model, label('gst_total'))} right={money(t.tax_paise)} />
          ) : null}
          {t.round_off_paise !== 0 ? (
            <Row left={biText(model, label('round_off'))} right={money(t.round_off_paise)} />
          ) : null}
          <Row
            className="grand"
            left={biText(model, label('total'))}
            right={money(t.total_paise)}
          />
        </tbody>
      </table>
      <div className="small words">
        {model.flags.bilingual || model.locale.primary === 'ta' ? (
          <div>{model.amount_in_words.ta}</div>
        ) : null}
        {model.flags.bilingual || model.locale.primary === 'en' ? (
          <div>{model.amount_in_words.en}</div>
        ) : null}
      </div>
      <TaxSummary model={model} compact={compact} />
      <hr />
      <PaymentsBlock model={model} />
      <Savings model={model} />
      <Loyalty model={model} />
      <Rx model={model} />
      {model.upi ? (
        <Qr
          text={model.upi.uri}
          size={compact ? '30mm' : '36mm'}
          caption={biText(model, label('scan_to_pay', { amount: money(model.upi.amount_paise) }))}
        />
      ) : null}
      {model.share_url && !model.upi ? (
        <Qr text={model.share_url} size="22mm" caption={primaryText(model, label('view_online'))} />
      ) : null}
      <Footer model={model} />
    </div>
  )
}

// =============================================================================================
// A4 tax invoice
// =============================================================================================

function A4Page({ model, copy }: { model: Model; copy: Bi | null }) {
  const t = model.totals
  const d = model.document
  const inter = d.is_interstate
  const showTax = model.doc_type !== 'bill_of_supply'
  const s = model.seller
  const shop = nameLines(model, s.name, s.name_ta)
  return (
    <div className="a4">
      <div className="a4-head">
        <div className="a4-seller">
          {s.logo_url ? <img className="logo" src={s.logo_url} alt="" /> : null}
          <div>
            <div className="shop">{shop.primary}</div>
            {shop.secondary ? <div className="shop-2">{shop.secondary}</div> : null}
            {s.legal_name && s.legal_name !== s.name ? <div>{s.legal_name}</div> : null}
            {s.address_lines.map((a) => (
              <div key={a}>{a}</div>
            ))}
            {s.phone ? (
              <div>
                {biText(model, label('phone'))}: {s.phone}
              </div>
            ) : null}
            {s.email ? <div>{s.email}</div> : null}
            {s.gstin ? <div className="bold">GSTIN: {s.gstin}</div> : null}
            {s.pan ? <div>PAN: {s.pan}</div> : null}
            {s.fssai_number ? <div>FSSAI: {s.fssai_number}</div> : null}
            {s.drug_license_numbers ? (
              <div>
                {biText(model, label('drug_licence'))}: {s.drug_license_numbers}
              </div>
            ) : null}
          </div>
        </div>
        <div className="a4-title">
          <div className="title">
            <BiLabel model={model} text={model.title} />
          </div>
          {copy ? <div className="copy">{biText(model, copy)}</div> : null}
          {d.cancelled ? <div className="stamp">{biText(model, label('cancelled'))}</div> : null}
        </div>
      </div>
      <table className="a4-info">
        <tbody>
          <tr>
            <td>
              <div className="cap">{biText(model, label('bill_to'))}</div>
              {model.buyer ? (
                <>
                  <div className="bold">{model.buyer.name}</div>
                  {model.buyer.address_lines.map((a) => (
                    <div key={a}>{a}</div>
                  ))}
                  {model.buyer.phone ? <div>{model.buyer.phone}</div> : null}
                  {model.buyer.gstin ? (
                    <div className="bold">GSTIN: {model.buyer.gstin}</div>
                  ) : null}
                  {model.buyer.state_name ? (
                    <div>
                      {primaryText(model, label('state'))}: {model.buyer.state_name} (
                      {model.buyer.state_code})
                    </div>
                  ) : null}
                </>
              ) : (
                <div>{biText(model, label('walk_in'))}</div>
              )}
            </td>
            <td>
              <div>
                {biText(model, model.kind === 'credit_note' ? label('note_no') : label('bill_no'))}:{' '}
                <b>{d.number ?? primaryText(model, label('provisional_no'))}</b>
              </div>
              <div>
                {biText(model, label('date'))}: {date(d.date)} {d.time}
              </div>
              <div>
                {biText(model, label('place_of_supply'))}: {d.place_of_supply_name} (
                {d.place_of_supply})
              </div>
              {showTax ? (
                <div>
                  {biText(model, label('reverse_charge'))}:{' '}
                  {primaryText(model, d.reverse_charge ? label('yes') : label('no'))}
                </div>
              ) : null}
              {d.original_invoice ? (
                <div>
                  {biText(model, label('original_invoice'))}: {d.original_invoice.number ?? '—'} ·{' '}
                  {date(d.original_invoice.date)}
                </div>
              ) : null}
              {d.reason ? (
                <div>
                  {primaryText(model, label('reason'))}: {biText(model, d.reason)}
                </div>
              ) : null}
              {d.valid_until ? (
                <div>
                  {primaryText(model, label('valid_until'))}: {date(d.valid_until)}
                </div>
              ) : null}
              {d.due_date ? (
                <div>
                  {primaryText(model, label('due_date'))}: {date(d.due_date)}
                </div>
              ) : null}
              {d.salesperson_name ? (
                <div>
                  {primaryText(model, label('salesperson'))}: {d.salesperson_name}
                </div>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
      <table className="a4-items">
        <thead>
          <tr>
            <th>#</th>
            <th className="left">{biText(model, label('item'))}</th>
            <th>HSN</th>
            <th className="num">{primaryText(model, label('qty'))}</th>
            {model.flags.show_mrp ? <th className="num">MRP</th> : null}
            <th className="num">{primaryText(model, label('rate'))}</th>
            <th className="num">{primaryText(model, label('discount'))}</th>
            {showTax ? <th className="num">{primaryText(model, label('taxable'))}</th> : null}
            {showTax ? <th className="num">GST</th> : null}
            {showTax ? (
              inter ? (
                <th className="num">{model.tax_labels.igst}</th>
              ) : (
                <>
                  <th className="num">{model.tax_labels.cgst}</th>
                  <th className="num">{model.tax_labels.sgst}</th>
                </>
              )
            ) : null}
            <th className="num">{primaryText(model, label('amount'))}</th>
          </tr>
        </thead>
        <tbody>
          {model.lines.map((l) => {
            const names = nameLines(model, l.name, l.name_ta)
            const chips = lineChips({ ...model, flags: { ...model.flags, show_hsn: false } }, l)
            return (
              <tr key={l.line_no}>
                <td className="center">{l.line_no}</td>
                <td className="left">
                  <div className="bold">{names.primary}</div>
                  {names.secondary ? <div className="small">{names.secondary}</div> : null}
                  {chips.length ? <div className="small">{chips.join(' · ')}</div> : null}
                  {l.note ? <div className="small">“{l.note}”</div> : null}
                </td>
                <td className="center">{l.hsn_code ?? ''}</td>
                <td className="num">
                  {primaryText(model, l.qty_display)}
                  <div className="small">{l.uqc}</div>
                </td>
                {model.flags.show_mrp ? (
                  <td className="num">{l.mrp_paise !== null ? moneyPlain(l.mrp_paise) : ''}</td>
                ) : null}
                <td className="num">{moneyPlain(l.rate_paise)}</td>
                <td className="num">{l.discount_paise > 0 ? moneyPlain(l.discount_paise) : ''}</td>
                {showTax ? <td className="num">{moneyPlain(l.taxable_paise)}</td> : null}
                {showTax ? <td className="num">{pct(l.gst_rate_bp)}</td> : null}
                {showTax ? (
                  inter ? (
                    <td className="num">{moneyPlain(l.igst_paise)}</td>
                  ) : (
                    <>
                      <td className="num">{moneyPlain(l.cgst_paise)}</td>
                      <td className="num">{moneyPlain(l.sgst_paise)}</td>
                    </>
                  )
                ) : null}
                <td className="num bold">{moneyPlain(l.total_paise)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="a4-bottom">
        <div className="a4-left">
          {showTax && model.hsn_summary.length ? (
            <table className="a4-hsn">
              <caption>{biText(model, label('hsn_summary'))}</caption>
              <thead>
                <tr>
                  <th>HSN</th>
                  <th className="num">GST</th>
                  <th className="num">{primaryText(model, label('taxable'))}</th>
                  {inter ? (
                    <th className="num">{model.tax_labels.igst}</th>
                  ) : (
                    <>
                      <th className="num">{model.tax_labels.cgst}</th>
                      <th className="num">{model.tax_labels.sgst}</th>
                    </>
                  )}
                  <th className="num">{primaryText(model, label('cess'))}</th>
                  <th className="num">{primaryText(model, label('gst_total'))}</th>
                </tr>
              </thead>
              <tbody>
                {model.hsn_summary.map((h) => (
                  <tr key={`${h.hsn_code ?? ''}-${h.gst_rate_bp}`}>
                    <td>{h.hsn_code ?? '—'}</td>
                    <td className="num">{pct(h.gst_rate_bp)}</td>
                    <td className="num">{moneyPlain(h.taxable_paise)}</td>
                    {inter ? (
                      <td className="num">{moneyPlain(h.igst_paise)}</td>
                    ) : (
                      <>
                        <td className="num">{moneyPlain(h.cgst_paise)}</td>
                        <td className="num">{moneyPlain(h.sgst_paise)}</td>
                      </>
                    )}
                    <td className="num">{moneyPlain(h.cess_paise)}</td>
                    <td className="num">{moneyPlain(h.tax_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="words">
            <div className="cap">{biText(model, label('amount_in_words'))}</div>
            {model.flags.bilingual || model.locale.primary === 'en' ? (
              <div>{model.amount_in_words.en}</div>
            ) : null}
            {model.flags.bilingual || model.locale.primary === 'ta' ? (
              <div>{model.amount_in_words.ta}</div>
            ) : null}
          </div>
          <Rx model={model} />
          {model.upi ? (
            <div className="a4-upi">
              <Qr text={model.upi.uri} size="28mm" />
              <div>
                <div className="bold">
                  {biText(model, label('scan_to_pay', { amount: money(model.upi.amount_paise) }))}
                </div>
                <div>UPI: {model.upi.vpa}</div>
                <div>{model.upi.payee_name}</div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="a4-right">
          <table className="totals">
            <tbody>
              <Row left={biText(model, label('subtotal'))} right={money(t.gross_paise)} />
              {t.discount_paise > 0 ? (
                <Row
                  left={biText(model, label('discount'))}
                  right={`−${money(t.discount_paise)}`}
                />
              ) : null}
              {t.loyalty_redeem_paise > 0 ? (
                <Row
                  left={biText(model, label('loyalty_redeemed'))}
                  right={`−${money(t.loyalty_redeem_paise)}`}
                />
              ) : null}
              {showTax ? (
                <Row left={biText(model, label('taxable'))} right={money(t.taxable_paise)} />
              ) : null}
              {showTax && !inter && t.cgst_paise > 0 ? (
                <Row left={model.tax_labels.cgst} right={money(t.cgst_paise)} />
              ) : null}
              {showTax && !inter && t.sgst_paise > 0 ? (
                <Row left={model.tax_labels.sgst} right={money(t.sgst_paise)} />
              ) : null}
              {showTax && t.igst_paise > 0 ? (
                <Row left={model.tax_labels.igst} right={money(t.igst_paise)} />
              ) : null}
              {t.cess_paise > 0 ? (
                <Row left={biText(model, label('cess'))} right={money(t.cess_paise)} />
              ) : null}
              {t.round_off_paise !== 0 ? (
                <Row left={biText(model, label('round_off'))} right={money(t.round_off_paise)} />
              ) : null}
              <Row
                className="grand"
                left={biText(model, label('total'))}
                right={money(t.total_paise)}
              />
            </tbody>
          </table>
          <PaymentsBlock model={model} />
          <Savings model={model} />
        </div>
      </div>
      <div className="a4-sign">
        <div className="a4-terms">
          <Footer model={model} />
        </div>
        <div className="sign">
          <div>
            {primaryText(model, label('signatory_for', { name: model.signatory.for_name }))}
          </div>
          <div className="sign-space" />
          <div>{biText(model, model.signatory.label)}</div>
        </div>
      </div>
    </div>
  )
}

export function A4Document({ model }: { model: Model }) {
  const copies = model.copies.length ? model.copies : [null]
  return (
    <>
      {copies.map((copy, i) => (
        <div key={i} className={i < copies.length - 1 ? 'page-break' : undefined}>
          <A4Page model={model} copy={copy} />
        </div>
      ))}
    </>
  )
}

/** Print CSS of the templates (added after lib/print's paper CSS). */
export const PRINT_TEMPLATE_CSS = `
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .small { font-size: 0.85em; }
  .shop { font-size: 1.35em; font-weight: 700; line-height: 1.2; }
  .shop-2 { font-size: 1.05em; font-weight: 600; }
  .logo { max-height: 18mm; max-width: 40mm; object-fit: contain; display: block; margin: 0 auto 2px; }
  .title { font-weight: 700; font-size: 1.1em; margin: 3px 0; }
  .stamp { font-weight: 800; border: 2px solid #000; display: inline-block; padding: 1px 6px; letter-spacing: 0.05em; }
  .receipt .stamp { display: block; margin: 2px auto; }
  table td, table th { padding: 1px 0; vertical-align: top; }
  th { text-align: left; font-weight: 700; }
  th.num { text-align: right; }
  .items th { border-bottom: 1px solid #000; }
  .items td.top, .items th.num { padding-left: 4px; white-space: nowrap; }
  .items.wide tr.item-nums td { padding-bottom: 2px; border-bottom: 1px dotted #999; }
  .items.wide tr.item-nums:last-child td { border-bottom: 0; }
  .nowrap { white-space: nowrap; }
  .items .name { font-weight: 600; }
  .items tr.item td { padding-top: 2px; }
  .chips { color: #222; }
  .totals td { padding: 1px 0; }
  .totals .grand td { font-size: 1.35em; font-weight: 800; border-top: 1px solid #000; padding-top: 3px; }
  .tax { margin-top: 4px; font-size: 0.85em; }
  .tax th { border-bottom: 1px solid #000; }
  .words { margin: 3px 0; font-style: italic; }
  .savings { margin: 4px 0; font-weight: 800; border: 1px dashed #000; padding: 2px; }
  .rx { margin-top: 4px; border: 1px solid #000; padding: 3px; font-size: 0.9em; }
  .qr { margin: 6px auto 2px; text-align: center; }
  .qr-img { display: inline-block; }
  .footer { margin-top: 6px; }
  .terms { white-space: pre-line; margin-top: 2px; }
  .buyer { margin: 2px 0; }
  .meta td { font-size: 0.9em; }
  /* A4 */
  .a4 { font-size: 11px; }
  .a4 table { border-collapse: collapse; }
  .a4-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; border-bottom: 2px solid #000; padding-bottom: 6px; }
  .a4-seller { display: flex; gap: 8px; }
  .a4-seller .logo { margin: 0; }
  .a4-title { text-align: right; }
  .a4-title .title { font-size: 1.6em; }
  .copy { font-size: 0.9em; font-style: italic; }
  .a4-info { margin: 6px 0; }
  .a4-info td { width: 50%; border: 1px solid #000; padding: 4px 6px; }
  .cap { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: #333; }
  .a4-items th, .a4-items td { border: 1px solid #000; padding: 3px 4px; }
  .a4-items th { background: #eee; text-align: center; }
  .a4-items .left { text-align: left; }
  .a4-bottom { display: flex; gap: 12px; margin-top: 6px; }
  .a4-left { flex: 1.4; }
  .a4-right { flex: 1; }
  .a4-hsn { font-size: 0.9em; margin-bottom: 6px; }
  .a4-hsn caption { text-align: left; font-weight: 700; padding-bottom: 2px; }
  .a4-hsn th, .a4-hsn td { border: 1px solid #000; padding: 2px 4px; }
  .a4-upi { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
  .a4-upi .qr { margin: 0; }
  .a4-sign { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; border-top: 1px solid #000; padding-top: 6px; }
  .a4-terms { flex: 1; text-align: left; }
  .a4-terms .footer { text-align: left; }
  .sign { text-align: right; min-width: 55mm; }
  .sign-space { height: 14mm; }
`
