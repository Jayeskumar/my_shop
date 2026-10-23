/**
 * Loads the lazily imported accounting pages before a test file's first render. Under a
 * parallel test run the first transform of a page module can take longer than Testing Library's
 * default findBy timeout; loading the modules in beforeAll keeps that cost out of the assertions.
 */
export async function preloadAccountingPages(): Promise<void> {
  await Promise.all([
    import('../pages/ExpensesPage'),
    import('../pages/ShiftsPage'),
    import('../pages/ShiftDetailPage'),
    import('../pages/DayBookPage'),
    import('../pages/LedgersPage'),
    import('../pages/JournalPage'),
    import('../pages/StatementsPage'),
    import('../pages/ChartOfAccountsPage'),
  ])
}

/** beforeAll timeout for preloadAccountingPages (cold transforms on a loaded machine). */
export const PRELOAD_TIMEOUT_MS = 60_000
