/**
 * Member picker for filters and assignments ("billed by", salesperson, shift / report filters):
 * GET /users/directory (any member; names, roles and status only), cached and searched locally.
 */
import { type UserDirectoryEntry, identityRoutes } from '@kadai/shared/api/identity'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, Badge, Combobox } from '@/components/ui'
import { useRouteQuery } from '@/lib/query'
import { PickerRow } from './picker-row'
import { PICKER_STALE_MS, type PickerBaseProps, bilingualNames, keywordsOf } from './shared'

export interface UserPickerProps extends PickerBaseProps {
  /** User id. */
  value: string | null | undefined
  onChange: (userId: string | null, user: UserDirectoryEntry | null) => void
  /** Members with access to this store (all-store members included). */
  storeId?: string | null
  /** Also disabled members (filters over old documents). */
  includeDisabled?: boolean
}

export function UserPicker({
  value,
  onChange,
  storeId,
  includeDisabled = false,
  placeholder,
  ...base
}: UserPickerProps) {
  const { t } = useTranslation('common')
  const directory = useRouteQuery(
    identityRoutes.userDirectory,
    {
      query: {
        ...(storeId ? { store_id: storeId } : {}),
        ...(includeDisabled ? { include_disabled: true } : {}),
      },
    },
    { staleTime: PICKER_STALE_MS },
  )
  const users = useMemo(() => directory.data?.data ?? [], [directory.data])
  const selected = useMemo(() => users.find((u) => u.id === value) ?? null, [users, value])
  return (
    <Combobox<UserDirectoryEntry>
      {...base}
      disabled={base.disabled || directory.isPending}
      value={selected}
      onChange={(u) => onChange(u?.id ?? null, u)}
      options={users}
      getOptionValue={(u) => u.id}
      getOptionLabel={(u) => keywordsOf(u.full_name, u.role_name, u.role_name_ta)}
      renderValue={(u) => u.full_name}
      renderOption={(u) => (
        <span className="flex items-center gap-2">
          <Avatar name={u.full_name} size="sm" />
          <PickerRow
            className="flex-1"
            title={u.full_name}
            subtitle={bilingualNames(u.role_name, u.role_name_ta).primary}
            aside={
              u.status === 'disabled' ? (
                <Badge tone="neutral" size="sm">
                  {t('pickers.user.disabled')}
                </Badge>
              ) : null
            }
          />
        </span>
      )}
      placeholder={placeholder ?? t('pickers.user.placeholder')}
      searchPlaceholder={t('pickers.user.search_placeholder')}
    />
  )
}
