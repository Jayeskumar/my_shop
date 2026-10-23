/** Renders the counter's active dialog (one at a time; see PosDialog in the controller). */
import { PinSwitchDialog } from '@/features/auth'
import { usePos } from '../state/pos-context'
import { BatchDialog } from './BatchDialog'
import { BillDiscountDialog } from './BillDiscountDialog'
import { CustomerAddDialog } from './CustomerAddDialog'
import { HeldBillsDialog } from './HeldBillsDialog'
import { HelpDialog } from './HelpDialog'
import { LineEditDialog } from './LineEditDialog'
import { PaymentDialog } from './PaymentDialog'
import { RxDialog } from './RxDialog'
import { ShiftDialog } from './ShiftDialog'
import { SyncDrawer } from './SyncDrawer'
import { VariantDialog } from './VariantDialog'
import { WeighDialog } from './WeighDialog'

export function PosDialogs() {
  const pos = usePos()
  const d = pos.dialog
  const close = (): void => {
    pos.closeDialog()
    pos.focusSearch()
  }
  if (!d) return null
  switch (d.name) {
    case 'payment':
      return <PaymentDialog initialMethod={d.method} initialOutcome={d.outcome} onClose={close} />
    case 'held':
      return <HeldBillsDialog onClose={close} />
    case 'bill_discount':
      return <BillDiscountDialog onClose={close} />
    case 'line':
      return <LineEditDialog lineKey={d.key} focus={d.focus} onClose={close} />
    case 'weigh':
      return <WeighDialog product={d.product} options={d.options} onClose={close} />
    case 'batch':
      return <BatchDialog lineKey={d.key} onClose={close} />
    case 'variants':
      return <VariantDialog parent={d.parent} options={d.options} onClose={close} />
    case 'rx':
      return (
        <RxDialog
          onClose={(saved) => {
            if (saved && d.then === 'payment') pos.openDialog({ name: 'payment' })
            else close()
          }}
        />
      )
    case 'shift':
      return <ShiftDialog onClose={close} />
    case 'help':
      return <HelpDialog onClose={close} />
    case 'sync':
      return <SyncDrawer onClose={close} />
    case 'customer_add':
      return <CustomerAddDialog draft={d.draft} onClose={close} />
    case 'pin':
      return <PinSwitchDialog open onOpenChange={(o) => !o && close()} onSwitched={() => close()} />
  }
}
