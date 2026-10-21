/**
 * Reusable accounting components for other features (the POS counter shows the shift chip and
 * opens / closes shifts and records cash in / out without leaving the billing screen).
 *
 *   import { OpenShiftDialog, CloseShiftDialog, CashEntryDialog, ShiftStatusBadge }
 *     from '@/features/accounting/components'
 */
export { CashEntryDialog, type CashEntryDialogProps } from './CashEntryDialog'
export { CloseShiftDialog, type CloseShiftDialogProps } from './CloseShiftDialog'
export { DenominationCounter, type DenominationCounterProps } from './DenominationCounter'
export { OpenShiftDialog, type OpenShiftDialogProps } from './OpenShiftDialog'
export { ShiftStatusBadge, type ShiftStatusBadgeProps } from './ShiftStatusBadge'
