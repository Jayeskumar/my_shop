/**
 * Data hooks of the settings feature, all through the identity route catalogue
 * (`identityRoutes` in @kadai/shared/api/identity) — no hand-written URLs. Mutations invalidate
 * the routes they affect; changes that the rest of the app reads from GET /me (settings, business
 * profile, stores, registers) also reload /me so pickers, the shell and the POS follow at once.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { routeUrl, type RouteDef, type RouteResponse } from '@kadai/shared/api/common'
import {
  identityRoutes as r,
  type AuditLogListQuery,
  type DeviceListQuery,
  type MemberListQuery,
  type NumberSeriesListQuery,
  type RegisterListQuery,
  type RoleListQuery,
  type StoreListQuery,
  type UploadPurpose,
} from '@kadai/shared/api/identity'
import { request } from '@/lib/api'
import { reloadMe } from '@/lib/auth'
import {
  routeQueryKey,
  useRouteMutation,
  useRouteQuery,
  type UseRouteMutationOptions,
} from '@/lib/query'

// ---------------------------------------------------------------------------------------------
// Generic mutation wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Route mutation that invalidates `invalidates` and, with `refreshMe`, reloads GET /me after
 * success (failures of that reload are ignored: the next /me load catches up).
 */
function useIdentityMutation<R extends RouteDef>(
  route: R,
  invalidates: readonly RouteDef[],
  options: UseRouteMutationOptions<R, unknown> & { refreshMe?: boolean } = {},
) {
  const { refreshMe = false, onSuccess, invalidates: extra, ...rest } = options
  return useRouteMutation(route, {
    // Forms show errors inline / with reason texts, so no generic toast by default.
    meta: { errorToast: false },
    ...rest,
    invalidates: [...invalidates, ...(extra ?? [])],
    onSuccess: async (...args) => {
      if (refreshMe) await reloadMe().catch(() => undefined)
      await onSuccess?.(...args)
    },
  })
}

type MutationOptions<R extends RouteDef> = UseRouteMutationOptions<R, unknown>

// ---------------------------------------------------------------------------------------------
// Settings & business profile
// ---------------------------------------------------------------------------------------------

export const useSettings = () => useRouteQuery(r.getSettings, {})

export const useUpdateSettings = (options?: MutationOptions<typeof r.updateSettings>) =>
  useIdentityMutation(r.updateSettings, [r.getSettings], { refreshMe: true, ...options })

export const useBusinessProfile = () => useRouteQuery(r.getBusinessProfile, {})

export const useUpdateBusinessProfile = (
  options?: MutationOptions<typeof r.updateBusinessProfile>,
) =>
  useIdentityMutation(r.updateBusinessProfile, [r.getBusinessProfile, r.getSettings], {
    refreshMe: true,
    ...options,
  })

// ---------------------------------------------------------------------------------------------
// Stores, registers, devices
// ---------------------------------------------------------------------------------------------

export const useStores = (query: StoreListQuery = { limit: 200 }) =>
  useRouteQuery(r.listStores, { query }, { placeholderData: keepPreviousData })

export const useCreateStore = (options?: MutationOptions<typeof r.createStore>) =>
  useIdentityMutation(r.createStore, [r.listStores, r.listRegisters], {
    refreshMe: true,
    ...options,
  })

export const useUpdateStore = (options?: MutationOptions<typeof r.updateStore>) =>
  useIdentityMutation(r.updateStore, [r.listStores, r.listRegisters, r.listDevices], {
    refreshMe: true,
    ...options,
  })

export const useRegisters = (query: RegisterListQuery = { limit: 200 }) =>
  useRouteQuery(r.listRegisters, { query }, { placeholderData: keepPreviousData })

export const useCreateRegister = (options?: MutationOptions<typeof r.createRegister>) =>
  useIdentityMutation(r.createRegister, [r.listRegisters, r.listStores], {
    refreshMe: true,
    ...options,
  })

export const useUpdateRegister = (options?: MutationOptions<typeof r.updateRegister>) =>
  useIdentityMutation(r.updateRegister, [r.listRegisters, r.listDevices], {
    refreshMe: true,
    ...options,
  })

export const useDevices = (query: DeviceListQuery) =>
  useRouteQuery(r.listDevices, { query }, { placeholderData: keepPreviousData })

export const useCreateDevice = (options?: MutationOptions<typeof r.createDevice>) =>
  useIdentityMutation(r.createDevice, [r.listDevices, r.listRegisters], options)

export const useRevokeDevice = (options?: MutationOptions<typeof r.revokeDevice>) =>
  useIdentityMutation(r.revokeDevice, [r.listDevices, r.listRegisters], options)

// ---------------------------------------------------------------------------------------------
// Users (members)
// ---------------------------------------------------------------------------------------------

export const useMembers = (query: MemberListQuery) =>
  useRouteQuery(r.listUsers, { query }, { placeholderData: keepPreviousData })

export const useCreateMember = (options?: MutationOptions<typeof r.createUser>) =>
  useIdentityMutation(r.createUser, [r.listUsers, r.listRoles], options)

export const useUpdateMember = (options?: MutationOptions<typeof r.updateUser>) =>
  useIdentityMutation(r.updateUser, [r.listUsers, r.listRoles], options)

export const useDisableMember = (options?: MutationOptions<typeof r.disableUser>) =>
  useIdentityMutation(r.disableUser, [r.listUsers], options)

export const useEnableMember = (options?: MutationOptions<typeof r.enableUser>) =>
  useIdentityMutation(r.enableUser, [r.listUsers], options)

export const useResetPin = (options?: MutationOptions<typeof r.resetUserPin>) =>
  useIdentityMutation(r.resetUserPin, [r.listUsers], options)

export const useResetPassword = (options?: MutationOptions<typeof r.resetUserPassword>) =>
  useIdentityMutation(r.resetUserPassword, [r.listUsers], options)

// ---------------------------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------------------------

export const useRoles = (query: RoleListQuery = { limit: 200 }) =>
  useRouteQuery(r.listRoles, { query }, { placeholderData: keepPreviousData })

export const usePermissionCatalog = () =>
  useRouteQuery(r.listPermissions, {}, { staleTime: Infinity })

export const useCreateRole = (options?: MutationOptions<typeof r.createRole>) =>
  useIdentityMutation(r.createRole, [r.listRoles], options)

export const useUpdateRole = (options?: MutationOptions<typeof r.updateRole>) =>
  useIdentityMutation(r.updateRole, [r.listRoles, r.listUsers], options)

export const useDeleteRole = (options?: MutationOptions<typeof r.deleteRole>) =>
  useIdentityMutation(r.deleteRole, [r.listRoles], options)

// ---------------------------------------------------------------------------------------------
// Number series & audit log
// ---------------------------------------------------------------------------------------------

export const useNumberSeries = (query: NumberSeriesListQuery) =>
  useRouteQuery(r.listNumberSeries, { query }, { placeholderData: keepPreviousData })

export const useCreateNumberSeries = (options?: MutationOptions<typeof r.createNumberSeries>) =>
  useIdentityMutation(r.createNumberSeries, [r.listNumberSeries], options)

export const useUpdateNumberSeries = (options?: MutationOptions<typeof r.updateNumberSeries>) =>
  useIdentityMutation(r.updateNumberSeries, [r.listNumberSeries], options)

export const useAuditLogs = (query: AuditLogListQuery, enabled = true) =>
  useRouteQuery(r.listAuditLogs, { query }, { placeholderData: keepPreviousData, enabled })

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export type UploadedFile = RouteResponse<typeof r.uploadFile>['data']

/**
 * Multipart upload through the catalogue's `uploadFile` route (POST /files?purpose=). The
 * catalogue describes no JSON body for it (the body is multipart), so the request is built from
 * the route definition instead of callRoute.
 */
export async function uploadFile(
  file: File,
  purpose: UploadPurpose,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const route = r.uploadFile
  const body = new FormData()
  body.append('file', file, file.name)
  const res = await request<RouteResponse<typeof route>>(route.method, routeUrl(route), {
    query: { purpose },
    body,
    signal,
    timeoutMs: 120_000,
  })
  return res.data
}

/**
 * Object URL of a stored file's content (the content route needs the bearer token, so it is
 * fetched as a blob). The blob is cached by the query client; the URL is revoked on unmount.
 */
export function useFileObjectUrl(fileId: string | null | undefined): {
  url: string | null
  loading: boolean
  error: unknown
} {
  const route = r.getFileContent
  const query = useQuery({
    queryKey: routeQueryKey(route, { params: { id: fileId ?? '' } }),
    queryFn: ({ signal }) =>
      request<Blob>(route.method, routeUrl(route, { id: fileId ?? '' }), {
        signal,
        responseType: 'blob',
      }),
    enabled: Boolean(fileId),
    staleTime: Infinity,
    meta: { errorToast: false },
  })
  const [url, setUrl] = useState<string | null>(null)
  const blob = fileId ? query.data : undefined
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return { url, loading: query.isLoading, error: query.error }
}
