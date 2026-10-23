/**
 * MSW handlers for the catalog screens (component / flow tests). Each handler records the
 * request (URL search params or JSON body) so tests can assert exactly what was sent.
 */
import { UNITS } from '@kadai/shared/units'
import { http, HttpResponse, type HttpHandler } from 'msw'
import { apiPath } from '@/test/msw'
import { brand, category, page, slabRule } from './fixtures'

export interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
}

export function recorder() {
  const calls: Recorded[] = []
  const record = async (request: Request): Promise<Recorded> => {
    const url = new URL(request.url)
    let body: unknown = null
    if (request.method !== 'GET' && request.method !== 'DELETE') {
      const type = request.headers.get('content-type') ?? ''
      body = type.includes('json') ? await request.clone().json() : null
    }
    const entry = {
      method: request.method,
      path: url.pathname.replace('/api/v1', ''),
      query: url.searchParams,
      body,
    }
    calls.push(entry)
    return entry
  }
  const find = (method: string, path: string): Recorded[] =>
    calls.filter((c) => c.method === method && c.path === path)
  return { calls, record, find }
}

/** Directory data every catalog screen may load (categories, brands, units, slab rules, HSN). */
export function directoryHandlers(): HttpHandler[] {
  const grocery = category({
    name: 'Grocery',
    name_ta: 'மளிகை',
    gst_rate_bp: 500,
    hsn_code: '1006',
  })
  const rice = category({
    name: 'Rice',
    name_ta: 'அரிசி',
    parent_id: grocery.id,
    depth: 2,
    path: 'Grocery > Rice',
    path_ta: 'மளிகை > அரிசி',
  })
  const rule = slabRule()
  return [
    http.get(apiPath('/categories'), ({ request }) => {
      const flat = new URL(request.url).searchParams.get('flat') === 'true'
      return HttpResponse.json({
        data: flat ? [grocery, rice] : [{ ...grocery, child_count: 1, children: [rice] }],
      })
    }),
    http.get(apiPath('/brands'), () => HttpResponse.json({ data: [brand()], page: page(1, 20) })),
    http.get(apiPath('/units'), () =>
      HttpResponse.json({ data: { units: UNITS, suggested: ['PCS', 'KG'] } }),
    ),
    http.get(apiPath('/tax-slab-rules'), () =>
      HttpResponse.json({ data: [rule], page: page(1, 200) }),
    ),
    http.get(apiPath('/hsn/search'), () =>
      HttpResponse.json({
        data: [
          {
            code: '1006',
            description: 'Rice',
            gst_rate_bp: 500,
            group: 'Groceries',
            slab_rule_hint: null,
          },
        ],
      }),
    ),
  ]
}
