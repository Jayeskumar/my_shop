/**
 * Background jobs of the accounting module (collected by src/jobs/registry.ts). See src/jobs/types.ts.
 *
 * The accounting module has no background work: every posting (manual journals, expenses, shift
 * cash entries and close differences) happens inside the business transaction that creates it,
 * and books / statements are computed on request from journal_lines.
 */
import type { KadaiJob } from '../../jobs/types'

export const jobs: readonly KadaiJob[] = []
