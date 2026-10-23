/**
 * Parties components shared with other modules (POS, sales, purchases, reports):
 *  - CustomerQuickAddDialog — short "add customer" form (pairs with CustomerPicker onCreate);
 *  - CustomerSummaryCard — due / overdue / credit / loyalty mini card for a picked customer;
 *  - PartyLedgerTable — khata / payable statement table for a PartyLedger.
 * Plus the building blocks they use (balance display, full customer / supplier forms, the
 * receive / pay dialog and the statement printer).
 */
export { BalanceAmount } from './BalanceAmount'
export { CreditLimitBar } from './CreditLimitBar'
export { CustomerFormDialog, type CustomerFormDialogProps } from './CustomerFormDialog'
export { CustomerQuickAddDialog, type CustomerQuickAddDialogProps } from './CustomerQuickAddDialog'
export { CustomerSummaryCard, type CustomerSummaryCardProps } from './CustomerSummaryCard'
export { PartyLedgerTable, type PartyLedgerTableProps } from './PartyLedgerTable'
export { PartyPaymentDialog, type PaymentParty } from './PartyPaymentDialog'
export { SupplierFormDialog, type SupplierFormDialogProps } from './SupplierFormDialog'
export type { CustomerDraftInput } from '../lib/customer-form'
export { STATEMENT_CSS, statementHtml, statementShareText } from '../lib/statement'
