/**
 * Counter actions shared by the keyboard map, the action bar and the phone menu, so F-keys and
 * taps do exactly the same thing (with the same guards and confirmations).
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { notify, useConfirm } from '@/components/ui'
import { openCustomerDisplayWindow } from '@/lib/display-channel'
import type { PosAction } from '../lib/keymap'
import { usePos } from './pos-context'
import { qtyInputId } from '../lib/dom-ids'

export type PosActionId = PosAction | 'estimate' | 'return' | 'display' | 'sync'

export function usePosActions(): {
  run: (action: PosActionId) => void
  enabled: (action: PosActionId) => boolean
} {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const hasLines = pos.cart.lines.length > 0
  const selected =
    pos.cart.lines.find((l) => l.key === pos.cart.selected_key) ?? pos.cart.lines.at(-1) ?? null

  const enabled = useCallback(
    (action: PosActionId): boolean => {
      switch (action) {
        case 'hold':
        case 'bill_discount':
        case 'pay':
        case 'cash_exact':
        case 'upi':
        case 'save_print':
        case 'clear':
          return hasLines && pos.busy === null
        case 'qty':
        case 'remove_line':
          return selected !== null
        case 'estimate':
          return hasLines && pos.online && pos.perms.createSales
        case 'return':
          return pos.perms.returns
        default:
          return true
      }
    },
    [hasLines, pos.busy, pos.online, pos.perms, selected],
  )

  const run = useCallback(
    (action: PosActionId): void => {
      if (!enabled(action)) return
      switch (action) {
        case 'help':
          pos.openDialog({ name: 'help' })
          return
        case 'search':
          pos.focusSearch()
          return
        case 'customer':
          pos.customerRef.current?.focus()
          return
        case 'hold':
          void pos.hold()
          return
        case 'recall':
          pos.openDialog({ name: 'held' })
          return
        case 'bill_discount':
          pos.openDialog({ name: 'bill_discount' })
          return
        case 'qty': {
          if (!selected) return
          const input = document.getElementById(qtyInputId(selected.key))
          if (input instanceof HTMLInputElement && input.offsetParent !== null) {
            input.focus()
            input.select()
          } else {
            pos.openDialog({ name: 'line', key: selected.key, focus: 'qty' })
          }
          return
        }
        case 'pay':
          pos.openDialog({ name: 'payment' })
          return
        case 'cash_exact': {
          const total = pos.pricing.result.total_paise
          void pos
            .completeSale([{ id: 'cash', method: 'cash', amount_paise: total }])
            .then((outcome) => {
              // Anything that needs the cashier (rx, blocked, price change) opens the dialog.
              if (outcome.status === 'needs_rx') pos.openDialog({ name: 'rx', then: 'payment' })
              else if (outcome.status !== 'done')
                pos.openDialog({ name: 'payment', method: 'cash', outcome })
            })
          return
        }
        case 'upi':
          pos.openDialog({ name: 'payment', method: 'upi' })
          return
        case 'save_print': {
          const method = pos.context?.settings.pos.default_payment_method ?? 'cash'
          if (method === 'cash') run('cash_exact')
          else pos.openDialog({ name: 'payment', method })
          return
        }
        case 'clear':
          void confirm({
            title: t('clear.title'),
            description: t('clear.description', { count: pos.cart.lines.length }),
            confirmLabel: t('clear.confirm'),
            tone: 'danger',
          }).then((ok) => {
            if (ok) pos.clearCart()
          })
          return
        case 'reprint':
          void pos.printLast()
          return
        case 'remove_line':
          if (selected) pos.dispatch({ type: 'remove', key: selected.key })
          return
        case 'next_line':
          pos.dispatch({ type: 'select_move', delta: 1 })
          return
        case 'previous_line':
          pos.dispatch({ type: 'select_move', delta: -1 })
          return
        case 'estimate':
          void pos.saveEstimate()
          return
        case 'return':
          void navigate('/sales/returns/new')
          return
        case 'display': {
          if (!openCustomerDisplayWindow()) notify.warning(t('display.popup_blocked'))
          return
        }
        case 'sync':
          pos.openDialog({ name: 'sync' })
          return
      }
    },
    [enabled, pos, selected, confirm, t, navigate],
  )

  return { run, enabled }
}
