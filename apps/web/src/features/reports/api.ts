/**
 * Data hooks of the reports screens. Every request goes through the shared route catalogue
 * (`reportsRoutes`) with the typed client — the generic viewer picks the route of a report from
 * the REPORTS catalogue (`def.route`).
 */
import type { Page, RouteDef } from '@kadai/shared/api/common'
import {
  type Gstr1Section,
  type ReportDef,
  type ReportMeta,
  REPORT_PAGE_MAX,
  gstr1ExportFilename,
  reportCsvFilename,
  reportsRoutes,
} from '@kadai/shared/api/reports'
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { type ApiError, callRoute, downloadRoute, type QueryParams } from '@/lib/api'
import { routeQueryKey } from '@/lib/query'
import type { ReportRow } from './lib/cells'

/** The report envelope every tabular report answers (`reportResponse()` in the contract). */
export interface ReportEnvelope {
  data: ReportRow[]
  page: Page
  totals: ReportRow
  meta: ReportMeta
}

export function reportRouteOf(def: ReportDef): RouteDef {
  return reportsRoutes[def.route]
}

/**
 * One page of a report. The viewer is generic over the catalogue, so the typed response of the
 * route (a union of the report schemas) is read through the common envelope shape.
 */
async function fetchReport(
  route: RouteDef,
  query: QueryParams,
  signal?: AbortSignal,
): Promise<ReportEnvelope> {
  const body: unknown = await callRoute(route, { query, signal })
  return body as ReportEnvelope
}

export function useReport(
  def: ReportDef,
  query: QueryParams,
  options: { enabled?: boolean } = {},
): UseQueryResult<ReportEnvelope, ApiError> {
  const route = reportRouteOf(def)
  return useQuery<ReportEnvelope, ApiError>({
    queryKey: routeQueryKey(route, { query }),
    queryFn: ({ signal }) => fetchReport(route, query, signal),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  })
}

/** Every row of the report for printing (one request, up to REPORT_PAGE_MAX rows). */
export function fetchAllRows(def: ReportDef, query: QueryParams): Promise<ReportEnvelope> {
  return fetchReport(reportRouteOf(def), { ...query, limit: REPORT_PAGE_MAX, offset: 0 })
}

/**
 * GSTR-1 download: the GST offline-tool JSON (upload on the portal) or the CSV of every section /
 * one section. The server names the file; the fallback name follows the contract.
 */
export function downloadGstr1(input: {
  period: string
  gstin: string
  format: 'json' | 'csv'
  section?: Gstr1Section
  /** Only when the user picked one of several registrations. */
  selectedGstin?: string
}): Promise<string> {
  return downloadRoute(reportsRoutes.gstr1Export, {
    query: {
      period: input.period,
      format: input.format,
      ...(input.selectedGstin ? { gstin: input.selectedGstin } : {}),
      ...(input.section ? { section: input.section } : {}),
    },
    filename: gstr1ExportFilename(input.gstin, input.period, input.format, input.section),
  })
}

/** `?format=csv` of the same report (all rows, English headers, totals row). */
export function downloadReportCsv(def: ReportDef, query: QueryParams): Promise<string> {
  const from = typeof query.from === 'string' ? query.from : null
  const to = typeof query.to === 'string' ? query.to : null
  const { limit: _limit, offset: _offset, ...rest } = query
  return downloadRoute(reportRouteOf(def), {
    query: { ...rest, format: 'csv' },
    filename: reportCsvFilename(def.key, from, to),
  })
}
