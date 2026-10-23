/**
 * The register's open shift (plan feature `shifts`): live from GET /shifts/current when online,
 * else the bootstrap's open_shift (offline).
 */
import { accountingRoutes } from '@kadai/shared/api/accounting'
import { useRouteQuery } from '@/lib/query'
import { usePos } from '../state/pos-context'

export interface ShiftInfo {
  id: string
  opened_at: string
  opened_by_name: string | null
  opening_cash_paise: number
}

/** The register's open shift: live from the server when online, else from the bootstrap. */
export function useShiftStatus(): {
  enabled: boolean
  required: boolean
  shift: ShiftInfo | null
  loading: boolean
} {
  const pos = usePos()
  const registerId = pos.scope?.registerId ?? null
  const enabled = pos.hasFeature('shifts') && registerId !== null
  const live = useRouteQuery(
    accountingRoutes.currentShift,
    { query: { register_id: registerId ?? '' } },
    { enabled: enabled && pos.online, refetchInterval: 5 * 60_000, meta: { errorToast: false } },
  )
  const fromServer = live.data?.data ?? null
  const shift: ShiftInfo | null = live.isSuccess
    ? fromServer
      ? {
          id: fromServer.id,
          opened_at: fromServer.opened_at,
          opened_by_name: fromServer.opened_by_name,
          opening_cash_paise: fromServer.opening_cash_paise,
        }
      : null
    : (pos.context?.open_shift ?? null)
  return {
    enabled,
    required: enabled && (pos.context?.shift_required ?? false),
    shift,
    loading: enabled && pos.online && live.isLoading,
  }
}
