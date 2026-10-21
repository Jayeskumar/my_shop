/**
 * Store access of a member: all stores (null) or a chosen list. With a single store the choice
 * is moot and only a note is shown.
 */
import { useTranslation } from 'react-i18next'
import { Checkbox, RadioGroup } from '@/components/ui'
import { useMe } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'

export function StoreAccessField({
  value,
  onChange,
  disabled,
  error,
}: {
  value: string[] | null
  onChange: (next: string[] | null) => void
  disabled?: boolean
  error?: string | undefined
}) {
  const { t } = useTranslation('settings')
  const me = useMe()
  const stores = me?.stores ?? []
  const myStores = me?.membership.store_ids ?? null
  // A store-scoped admin can only hand out stores they have themselves.
  const offered = myStores === null ? stores : stores.filter((s) => myStores.includes(s.id))
  if (stores.length <= 1) {
    return <p className="text-sm text-muted-foreground">{t('users.single_store_note')}</p>
  }
  const mode = value === null ? 'all' : 'some'
  return (
    <div className="flex flex-col gap-3">
      <RadioGroup<'all' | 'some'>
        orientation="horizontal"
        value={mode}
        disabled={disabled}
        onValueChange={(m) =>
          onChange(m === 'all' ? null : (value ?? offered.slice(0, 1).map((s) => s.id)))
        }
        options={[
          {
            value: 'all',
            label: t('users.access_all'),
            disabled: myStores !== null,
          },
          { value: 'some', label: t('users.access_some') },
        ]}
      />
      {mode === 'some' ? (
        <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          {offered.map((s) => {
            const checked = value?.includes(s.id) ?? false
            return (
              <Checkbox
                key={s.id}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(c) => {
                  const current = value ?? []
                  onChange(c === true ? [...current, s.id] : current.filter((id) => id !== s.id))
                }}
                label={
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">{s.code}</span>{' '}
                    {localizedName(s.name, s.name_ta)}
                  </span>
                }
              />
            )
          })}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
