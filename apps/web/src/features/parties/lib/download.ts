/**
 * Statement CSV in a chosen language. The server writes CSV headings and row types in the
 * request locale (`x-locale`), so — like print — a Tamil CSV can be made from an English screen
 * and the other way round. The file name comes from the server's Content-Disposition.
 */
import { type RouteDef, routeUrl } from '@kadai/shared/api/common'
import { request, saveBlob } from '@/lib/api'
import type { Language } from '@/lib/i18n'

export async function downloadStatementCsv(
  route: RouteDef,
  input: {
    params: Record<string, string>
    query: Record<string, string | undefined>
    lang: Language
    filename: string
  },
): Promise<string> {
  const query: Record<string, string> = { format: 'csv' }
  for (const [k, v] of Object.entries(input.query)) if (v) query[k] = v
  const response = await request<Response>(route.method, routeUrl(route, input.params), {
    query,
    headers: { Accept: 'text/csv', 'x-locale': input.lang },
    responseType: 'response',
    timeoutMs: 120_000,
  })
  const disposition = response.headers.get('content-disposition') ?? ''
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1]?.trim() || input.filename
  saveBlob(await response.blob(), filename)
  return filename
}
