/**
 * Files API (identity catalogue) for product photos and import files: multipart upload to
 * POST /files?purpose=, and authenticated blob fetch of GET /files/:id/content for <img>.
 */
import { routeUrl } from '@kadai/shared/api/common'
import {
  type FileMeta,
  type UploadPurpose,
  fileUploadIssue,
  identityRoutes,
} from '@kadai/shared/api/identity'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { request } from '@/lib/api'

export type UploadIssue = NonNullable<ReturnType<typeof fileUploadIssue>>

/** Client-side check before uploading (same rules as the server). */
export function uploadIssue(purpose: UploadPurpose, file: File): UploadIssue | null {
  return fileUploadIssue(purpose, file)
}

/** Uploads one file; the route has no JSON body, so the multipart form goes through `request`. */
export async function uploadFile(
  file: File,
  purpose: UploadPurpose,
  signal?: AbortSignal,
): Promise<FileMeta> {
  const route = identityRoutes.uploadFile
  const form = new FormData()
  form.append('file', file, file.name)
  const res = await request<{ data: FileMeta }>(route.method, routeUrl(route), {
    query: { purpose },
    body: form,
    signal,
    timeoutMs: 120_000,
  })
  return res.data
}

/** Authenticated content of a stored file as a Blob. */
export function fetchFileBlob(fileId: string, signal?: AbortSignal): Promise<Blob> {
  const route = identityRoutes.getFileContent
  return request<Blob>(route.method, routeUrl(route, { id: fileId }), {
    signal,
    responseType: 'blob',
    headers: { Accept: '*/*' },
  })
}

/**
 * Object URL of a stored file (product photo). Content is immutable per id, so the blob is
 * cached for the session; the object URL is revoked when the component unmounts.
 */
export function useFileObjectUrl(fileId: string | null | undefined): string | null {
  const blob = useQuery({
    queryKey: ['catalog', 'file-content', fileId],
    queryFn: ({ signal }) => fetchFileBlob(fileId!, signal),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    meta: { errorToast: false },
    retry: false,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob.data || typeof URL.createObjectURL !== 'function') {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob.data)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob.data])
  return url
}
