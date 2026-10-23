/**
 * Result of "Test" on a shop UPI ID: the server's ₹1 `upi://pay` URI as a QR the owner scans
 * with their own phone — the UPI app must show the shop's name; paying ₹1 to yourself proves
 * the money reaches the right account.
 */
import { CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PaymentProviderAccount, ProviderTestResult } from '@kadai/shared/api/payments'
import { Button, Dialog } from '@/components/ui'
import { formatMoney } from '@/lib/format'
import { QrCode } from '../components/QrCode'
import { TEST_AMOUNT_PAISE } from './UpiVpaDialog'

export function TestQrDialog({
  result,
  account,
  onOpenChange,
}: {
  result: ProviderTestResult | null
  account: PaymentProviderAccount | null
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['payments', 'common'])
  const uri = result?.test_upi_uri ?? null
  return (
    <Dialog
      open={Boolean(result && account)}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('settings.upi.test_title')}
      description={account?.vpa ?? undefined}
      footer={<Button onClick={() => onOpenChange(false)}>{t('common:actions.done')}</Button>}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        {uri ? (
          <QrCode
            value={uri}
            label={t('settings.upi.test_qr_label', { vpa: account?.vpa ?? '' })}
            className="w-56 border border-border p-1"
          />
        ) : null}
        <p className="text-lg font-semibold">{formatMoney(TEST_AMOUNT_PAISE)}</p>
        <ol className="grid list-decimal gap-1 ps-5 text-start text-sm text-muted-foreground">
          <li>{t('settings.upi.test_step_scan')}</li>
          <li>{t('settings.upi.test_step_name', { payee: account?.payee_name ?? '' })}</li>
          <li>{t('settings.upi.test_step_pay')}</li>
        </ol>
        {result?.ok ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            {t('settings.upi.test_format_ok')}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
