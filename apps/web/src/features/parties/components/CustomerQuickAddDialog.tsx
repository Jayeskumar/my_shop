/**
 * Quick "add customer" for the POS and other modules: the short form (name, mobile, Tamil name,
 * type, WhatsApp consent) that can expand to every field. Pair it with CustomerPicker's
 * `onCreate`, which passes the typed name or mobile number as `draft`.
 *
 *   <CustomerPicker value={c} onChange={setC} onCreate={(d) => { setDraft(d); setOpen(true) }} />
 *   <CustomerQuickAddDialog open={open} onOpenChange={setOpen} draft={draft} onCreated={setC} />
 */
import type { Customer } from '@kadai/shared/api/parties'
import type { CustomerDraftInput } from '../lib/customer-form'
import { CustomerFormDialog } from './CustomerFormDialog'

export interface CustomerQuickAddDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Name or mobile number typed by the cashier. */
  draft?: CustomerDraftInput
  /** The created customer (a CustomerListItem superset — fits CustomerPicker's value). */
  onCreated?: (customer: Customer) => void
}

export function CustomerQuickAddDialog({
  open,
  onOpenChange,
  draft,
  onCreated,
}: CustomerQuickAddDialogProps) {
  return (
    <CustomerFormDialog
      open={open}
      onOpenChange={onOpenChange}
      draft={draft}
      compact
      onSaved={onCreated}
    />
  )
}
