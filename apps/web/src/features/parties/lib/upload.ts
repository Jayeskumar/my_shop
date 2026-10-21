/**
 * Multipart upload through the identity catalogue's `uploadFile` route (POST /files?purpose=).
 * The catalogue describes no JSON body for it (the body is multipart), so the request is built
 * from the route definition here instead of `callRoute`.
 */
import { type RouteResponse, routeUrl } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
import type { UploadPurpose } from '@kadai/shared/api/identity'
import { request } from '@/lib/api'

export function uploadFile(
  file: File,
  purpose: UploadPurpose,
  signal?: AbortSignal,
): Promise<RouteResponse<typeof identityRoutes.uploadFile>> {
  const route = identityRoutes.uploadFile
  const body = new FormData()
  body.append('file', file, file.name)
  return request<RouteResponse<typeof route>>(route.method, routeUrl(route), {
    query: { purpose },
    body,
    signal,
    timeoutMs: 120_000,
  })
}
