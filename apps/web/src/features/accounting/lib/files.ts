/**
 * Bill photos of expenses (identity catalogue): multipart upload to POST /files?purpose=attachment
 * and the authenticated blob of GET /files/:id/content for the preview. The upload route has no
 * JSON body in the catalogue, so the request is built from the route definition (routeUrl) and
 * sent with the shared `request` (auth + refresh handled there).
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { routeUrl } from '@kadai/shared/api/common'
import {
  FILE_UPLOAD_RULES,
  type FileMeta,
  fileUploadIssue,
  identityRoutes,
} from '@kadai/shared/api/identity'
import { request } from '@/lib/api'
import { routeQueryKey } from '@/lib/query'

export const ATTACHMENT_RULE = FILE_UPLOAD_RULES.attachment
export type UploadIssue = NonNullable<ReturnType<typeof fileUploadIssue>>

/** Client-side check before uploading (same rules as the server). */
export function attachmentIssue(file: File): UploadIssue | null {
  return fileUploadIssue('attachment', file)
}

export async function uploadAttachment(file: File, signal?: AbortSignal): Promise<FileMeta> {
  const route = identityRoutes.uploadFile
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await request<{ data: FileMeta }>(route.method, routeUrl(route), {
    query: { purpose: 'attachment' },
    body: form,
    signal,
    timeoutMs: 120_000,
  })
  return res.data
}

/** File metadata (name, type) of a stored attachment. */
export function useFileMeta(fileId: string | null | undefined) {
  const route = identityRoutes.getFile
  return useQuery({
    queryKey: routeQueryKey(route, { params: { id: fileId ?? '' } }),
    queryFn: ({ signal }) =>
      request<{ data: FileMeta }>(route.method, routeUrl(route, { id: fileId ?? '' }), { signal }),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    meta: { errorToast: false },
    retry: false,
  })
}

/**
 * Object URL of a stored attachment (the content route needs the bearer token, so it is fetched
 * as a blob). Content is immutable per id; the URL is revoked when the component unmounts.
 */
export function useAttachmentUrl(fileId: string | null | undefined): {
  url: string | null
  type: string | null
  loading: boolean
  error: unknown
} {
  const route = identityRoutes.getFileContent
  const blob = useQuery({
    queryKey: routeQueryKey(route, { params: { id: fileId ?? '' } }),
    queryFn: ({ signal }) =>
      request<Blob>(route.method, routeUrl(route, { id: fileId ?? '' }), {
        signal,
        responseType: 'blob',
        headers: { Accept: '*/*' },
      }),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    meta: { errorToast: false },
    retry: false,
  })
  const [url, setUrl] = useState<string | null>(null)
  const data = fileId ? blob.data : undefined
  useEffect(() => {
    if (!data || typeof URL.createObjectURL !== 'function') {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [data])
  return { url, type: data?.type ?? null, loading: blob.isLoading, error: blob.error }
}
