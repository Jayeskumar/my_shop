/**
 * Convert an estimate into a bill (POST /sales/estimates/:id/convert). Either a draft bill —
 * recalled at the billing counter to take payment and print — or a completed bill right here,
 * paid in cash or put on the customer's khata. Prices are re-checked at today's prices unless
 * "keep the estimate's prices" is on. The estimate becomes 'converted' and links to the bill.
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  EstimateConvertSchema,
  type EstimateConvert,
  type SalesInvoiceDetail,
} from '@kadai/shared/api/sales'
import { newId } from '@kadai/shared/ids'
import { Button, Dialog, FormField, MoneyInput, RadioGroup, Switch, notify } from '@/components/ui'
import { useCan, useCurrentRegister, useFeature } from '@/lib/auth'
import { errorText } from '@/lib/errors'
import { formatMoney } from '@/lib/format'
import { useConvertEstimate } from '../api'
import { contractIssues, useValidationText } from '../lib/forms'

type Mode = 'draft' | 'cash' | 'credit'

export interface ConvertEstimateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  estimate: SalesInvoiceDetail
}

export function ConvertEstimateDialog(props: ConvertEstimateDialogProps) {
  return props.open ? <ConvertBody {...props} /> : null
}

function ConvertBody({ onOpenChange, estimate }: ConvertEstimateDialogProps) {
  const { t } = useTranslation(['sales', 'common'])
  const vt = useValidationText()
  const navigate = useNavigate()
  const register = useCurrentRegister()
  const canCredit = useCan('sales.credit')
  const khata = useFeature('khata')
  const convert = useConvertEstimate()
  const clientRef = useRef(newId()).current
  const [mode, setMode] = useState<Mode>('draft')
  const [keepPrices, setKeepPrices] = useState(true)
  const [cash, setCash] = useState<number | null>(estimate.total_paise)
  const [error, setError] = useState<string | null>(null)
  const creditAllowed = canCredit && khata && estimate.customer_id !== null
  const registerId = register && register.store_id === estimate.store_id ? register.id : null

  const toBody = (): EstimateConvert => ({
    status: mode === 'draft' ? 'draft' : 'completed',
    keep_prices: keepPrices,
    tenders: mode === 'cash' ? [{ method: 'cash', amount_paise: cash ?? 0 }] : [],
    channel: 'backoffice',
    ...(registerId ? { register_id: registerId } : {}),
    client_ref: clientRef,
  })

  const submit = (): void => {
    if (mode === 'cash' && (cash ?? 0) <= 0) {
      setError(t('collect.amount_required'))
      return
    }
    const body = toBody()
    const issues = contractIssues(EstimateConvertSchema, body)
    const first = Object.values(issues)[0]
    if (first) {
      setError(vt(first) ?? first)
      return
    }
    setError(null)
    convert.mutate(
      { params: { id: estimate.id }, body, idempotencyKey: clientRef },
      {
        onSuccess: (res) => {
          const bill = res.data.invoice
          notify.success(
            bill.status === 'draft'
              ? t('convert.done_draft')
              : t('convert.done_bill', { number: bill.number ?? '' }),
            res.data.change_paise > 0
              ? {
                  description: t('collect.give_change', {
                    amount: formatMoney(res.data.change_paise),
                  }),
                }
              : undefined,
          )
          onOpenChange(false)
          navigate(`/sales/invoices/${bill.id}`)
        },
        onError: (e) => setError(errorText(e)),
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={onOpenChange}
      dismissible={!convert.isPending}
      title={t('convert.title', { number: estimate.number ?? '' })}
      description={t('convert.description')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={convert.isPending}>
            {t('common:actions.cancel')}
          </Button>
          <Button onClick={submit} loading={convert.isPending}>
            {mode === 'draft' ? t('convert.make_draft') : t('convert.make_bill')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup<Mode>
          aria-label={t('convert.how')}
          variant="cards"
          value={mode}
          onValueChange={(m) => {
            setMode(m)
            setError(null)
          }}
          options={[
            {
              value: 'draft',
              label: t('convert.mode_draft'),
              description: t('convert.mode_draft_hint'),
            },
            {
              value: 'cash',
              label: t('convert.mode_cash'),
              description: t('convert.mode_cash_hint'),
            },
            {
              value: 'credit',
              label: t('convert.mode_credit'),
              description: creditAllowed
                ? t('convert.mode_credit_hint')
                : t('convert.mode_credit_unavailable'),
              disabled: !creditAllowed,
            },
          ]}
        />
        {mode === 'cash' ? (
          <FormField label={t('collect.cash_given')} hint={t('convert.cash_hint')} required>
            <MoneyInput value={cash} onChange={setCash} size="lg" />
          </FormField>
        ) : null}
        <Switch
          checked={keepPrices}
          onCheckedChange={setKeepPrices}
          label={t('convert.keep_prices')}
          description={keepPrices ? t('convert.keep_prices_on') : t('convert.keep_prices_off')}
        />
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground"
          >
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
