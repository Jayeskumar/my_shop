/**
 * Loads the lazily imported inventory pages before a test file's first render. Under a parallel
 * test run the first transform of a page module can take longer than Testing Library's default
 * findBy timeout; loading the modules in beforeAll keeps that cost out of the assertions.
 */
export async function preloadInventoryPages(): Promise<void> {
  await Promise.all([
    import('../pages/StockPage'),
    import('../pages/MovementsPage'),
    import('../pages/BatchesPage'),
    import('../pages/AdjustmentsPage'),
    import('../pages/AdjustmentNewPage'),
    import('../pages/AdjustmentPage'),
    import('../pages/TransfersPage'),
    import('../pages/TransferNewPage'),
    import('../pages/TransferPage'),
  ])
}

/** beforeAll timeout for preloadInventoryPages (cold transforms on a loaded machine). */
export const PRELOAD_TIMEOUT_MS = 60_000
