/**
 * Data hooks of the notifications screens — every call goes through the shared route
 * catalogues (`notificationsRoutes`, plus identity's settings and parties' customer summary), so
 * paths, params and response types come from the contract. Mutations opt out of the central
 * error toast: every caller shows the error itself (inline field errors, the reason's own text).
 */
import { keepPreviousData, type QueryClient, useQueryClient } from '@tanstack/react-query'
import type { RouteResponse } from '@kadai/shared/api/common'
import { identityRoutes } from '@kadai/shared/api/identity'
import {
  type Notification,
  type NotificationListQuery,
  type NotificationTemplateEntry,
  OUTBOX_REFRESH_SECONDS,
  notificationsRoutes,
} from '@kadai/shared/api/notifications'
import { partiesRoutes } from '@kadai/shared/api/parties'
import { reloadMe } from '@/lib/auth'
import { routeQueryKey, useRouteMutation, useRouteQuery } from '@/lib/query'

type ListResponse = RouteResponse<typeof notificationsRoutes.listNotifications>
type DetailResponse = RouteResponse<typeof notificationsRoutes.getNotification>
type CatalogResponse = RouteResponse<typeof notificationsRoutes.listTemplates>

// ---- outbox ------------------------------------------------------------------------------------

/** GET /notifications — refreshes every OUTBOX_REFRESH_SECONDS while `autoRefresh` (visible tab). */
export function useNotifications(query: NotificationListQuery, autoRefresh: boolean) {
  return useRouteQuery(
    notificationsRoutes.listNotifications,
    { query },
    {
      placeholderData: keepPreviousData,
      refetchInterval: autoRefresh ? OUTBOX_REFRESH_SECONDS * 1000 : false,
      refetchIntervalInBackground: false,
    },
  )
}

/** GET /notifications/:id (detail drawer). */
export function useNotification(id: string | null, autoRefresh = false) {
  return useRouteQuery(
    notificationsRoutes.getNotification,
    { params: { id: id ?? '' } },
    {
      enabled: Boolean(id),
      refetchInterval: autoRefresh ? OUTBOX_REFRESH_SECONDS * 1000 : false,
    },
  )
}

function patchCachedNotification(
  qc: QueryClient,
  id: string,
  patch: (n: Notification) => Notification,
): void {
  qc.setQueriesData<ListResponse>(
    { queryKey: routeQueryKey(notificationsRoutes.listNotifications) },
    (old) => (old ? { ...old, data: old.data.map((n) => (n.id === id ? patch(n) : n)) } : old),
  )
  qc.setQueriesData<DetailResponse>(
    { queryKey: routeQueryKey(notificationsRoutes.getNotification, { params: { id } }) },
    (old) => (old ? { ...old, data: patch(old.data) } : old),
  )
}

interface RetryContext {
  lists: Array<[readonly unknown[], ListResponse | undefined]>
  details: Array<[readonly unknown[], DetailResponse | undefined]>
}

/**
 * POST /notifications/:id/retry with optimistic feedback: the row shows 'queued' at once and
 * rolls back if the server refuses (409 not_retryable, …).
 */
export function useRetryNotification() {
  const qc = useQueryClient()
  return useRouteMutation<typeof notificationsRoutes.retryNotification, RetryContext>(
    notificationsRoutes.retryNotification,
    {
      meta: { errorToast: false },
      onMutate: async ({ params }) => {
        const listKey = routeQueryKey(notificationsRoutes.listNotifications)
        const detailKey = routeQueryKey(notificationsRoutes.getNotification, { params })
        await qc.cancelQueries({ queryKey: listKey })
        await qc.cancelQueries({ queryKey: detailKey })
        const context: RetryContext = {
          lists: qc.getQueriesData<ListResponse>({ queryKey: listKey }),
          details: qc.getQueriesData<DetailResponse>({ queryKey: detailKey }),
        }
        patchCachedNotification(qc, params.id, (n) => ({
          ...n,
          status: 'queued',
          error: null,
          can_retry: false,
        }))
        return context
      },
      onError: (_error, _vars, context) => {
        for (const [key, value] of context?.lists ?? []) qc.setQueryData(key, value)
        for (const [key, value] of context?.details ?? []) qc.setQueryData(key, value)
      },
      onSuccess: (res) => {
        patchCachedNotification(qc, res.data.id, () => res.data)
      },
      onSettled: () =>
        qc.invalidateQueries({ queryKey: routeQueryKey(notificationsRoutes.listNotifications) }),
    },
  )
}

// ---- templates, providers & settings -----------------------------------------------------------

/** GET /notification-templates — templates × channels × languages, providers, settings. */
export function useTemplateCatalog(enabled = true) {
  return useRouteQuery(notificationsRoutes.listTemplates, { query: {} }, { enabled })
}

function replaceCatalogEntry(qc: QueryClient, entry: NotificationTemplateEntry): void {
  qc.setQueriesData<CatalogResponse>(
    { queryKey: routeQueryKey(notificationsRoutes.listTemplates) },
    (old) =>
      old
        ? {
            ...old,
            data: {
              ...old.data,
              templates: old.data.templates.map((t) =>
                t.code === entry.code && t.channel === entry.channel && t.locale === entry.locale
                  ? entry
                  : t,
              ),
            },
          }
        : old,
  )
}

/** PUT /notification-templates/:code/:channel/:locale — the new entry replaces the cached one. */
export function useUpsertTemplate() {
  const qc = useQueryClient()
  return useRouteMutation(notificationsRoutes.upsertTemplate, {
    meta: { errorToast: false },
    onSuccess: (res) => replaceCatalogEntry(qc, res.data),
  })
}

/** DELETE /notification-templates/:code/:channel/:locale — back to the standard text. */
export function useResetTemplate() {
  const qc = useQueryClient()
  return useRouteMutation(notificationsRoutes.deleteTemplate, {
    meta: { errorToast: false },
    onSuccess: (res) => replaceCatalogEntry(qc, res.data),
  })
}

/**
 * PATCH /settings with a `notifications` patch (identity contract). The catalogue's settings
 * copy and /me (read by billing for invoice sharing) are refreshed from the answer.
 */
export function useUpdateNotificationSettings() {
  const qc = useQueryClient()
  return useRouteMutation(identityRoutes.updateSettings, {
    meta: { errorToast: false },
    invalidates: [identityRoutes.getSettings],
    onSuccess: async (res) => {
      qc.setQueriesData<CatalogResponse>(
        { queryKey: routeQueryKey(notificationsRoutes.listTemplates) },
        (old) =>
          old ? { ...old, data: { ...old.data, settings: res.data.settings.notifications } } : old,
      )
      try {
        await reloadMe()
      } catch {
        // The saved settings stand; /me catches up on the next load.
      }
    },
  })
}

/** POST /notifications/send — the "send a test" button of the provider cards. */
export function useSendNotification() {
  return useRouteMutation(notificationsRoutes.sendNotification, {
    meta: { errorToast: false },
    invalidates: [notificationsRoutes.listNotifications],
  })
}

// ---- customer reminders ------------------------------------------------------------------------

/** POST /customers/:id/remind; refreshes the outbox and the customer's khata views. */
export function useRemindCustomer() {
  return useRouteMutation(notificationsRoutes.remindCustomer, {
    meta: { errorToast: false },
    invalidates: [notificationsRoutes.listNotifications, partiesRoutes.getCustomer],
  })
}

/** GET /customers/:id/summary (age of the oldest unpaid bill for the reminder preview). */
export function useCustomerSummary(id: string | null, enabled: boolean) {
  return useRouteQuery(
    partiesRoutes.customerSummary,
    { params: { id: id ?? '' } },
    { enabled: enabled && Boolean(id), meta: { errorToast: false } },
  )
}
