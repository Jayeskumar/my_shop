/**
 * The POS keyboard map (ARCHITECTURE.md §12): one list drives the hotkey bindings, the F-key
 * hints on the action bar and the F1 help overlay.
 */

export const POS_ACTIONS = [
  'help',
  'search',
  'customer',
  'hold',
  'recall',
  'bill_discount',
  'qty',
  'pay',
  'cash_exact',
  'upi',
  'save_print',
  'clear',
  'reprint',
  'remove_line',
  'next_line',
  'previous_line',
] as const
export type PosAction = (typeof POS_ACTIONS)[number]

export const POS_KEYMAP: Readonly<Record<PosAction, string>> = {
  help: 'F1',
  search: 'F2',
  customer: 'F3',
  hold: 'F4',
  recall: 'F5',
  bill_discount: 'F6',
  qty: 'F7',
  pay: 'F8',
  cash_exact: 'F9',
  upi: 'F10',
  save_print: 'F12',
  clear: 'Escape',
  reprint: 'ctrl+p',
  remove_line: 'Delete',
  next_line: 'ArrowDown',
  previous_line: 'ArrowUp',
}

/** Shortcuts listed in the help overlay, in this order. */
export const HELP_ORDER: readonly PosAction[] = [
  'search',
  'customer',
  'qty',
  'bill_discount',
  'pay',
  'cash_exact',
  'upi',
  'save_print',
  'hold',
  'recall',
  'reprint',
  'remove_line',
  'next_line',
  'previous_line',
  'clear',
  'help',
]
