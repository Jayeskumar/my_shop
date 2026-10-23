/** Prints a receipt / payment voucher (bilingual) on the shop's receipt paper. */
import { useTranslation } from 'react-i18next'
import type { PaymentDetail } from '@kadai/shared/api/payments'
import { notify } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { printHtml } from '@/lib/print'
import { RECEIPT_CSS, receiptHtml, receiptPaper, type ShopHeader } from './print-docs'

export function usePrintReceipt(): (payment: PaymentDetail) => Promise<void> {
  const me = useMe()
  const { t } = useTranslation('payments')
  return async (payment) => {
    const tenant = me?.tenant
    const shop: ShopHeader = {
      name: tenant?.name ?? '',
      name_ta: tenant?.name_ta ?? null,
      address: tenant?.address
        ? [tenant.address.line1, tenant.address.city, tenant.address.pincode]
            .filter(Boolean)
            .join(', ')
        : null,
      phone: tenant?.phone ?? null,
      gstin: tenant?.gstin ?? null,
    }
    try {
      await printHtml(receiptHtml(payment, shop), {
        paper: receiptPaper(me?.settings.invoice.print_format),
        css: RECEIPT_CSS,
        title: payment.number ?? t('detail.title_fallback'),
      })
    } catch (error) {
      notify.error(error)
    }
  }
}
