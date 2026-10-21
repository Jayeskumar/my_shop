/**
 * Inventory components other modules may reuse:
 *  - StockBadge / StockStatusBadge / ExpiryBadge / QtyChange — stock, expiry and movement
 *    indicators (product page, pickers, POS hints, purchase lines);
 *  - StockByBatch — stock of one product per store and batch (GET /stock/products/:productId).
 */
export { ExpiryBadge, QtyChange, StockBadge, StockStatusBadge } from './components/StockBadge'
export type { ExpiryBadgeProps, StockBadgeProps } from './components/StockBadge'
export { StockByBatch } from './components/StockByBatch'
export type { StockByBatchProps } from './components/StockByBatch'
