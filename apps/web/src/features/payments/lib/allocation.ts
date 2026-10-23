/** Allocation helpers shared by the receipt / voucher form and its allocation table. */
import type { OpenItem } from '@kadai/shared/api/payments'

/** Stable key of an open item (target type + id; opening balance rows use the party id). */
export const itemKey = (i: Pick<OpenItem, 'target_type' | 'target_id'>): string =>
  `${i.target_type}:${i.target_id}`
