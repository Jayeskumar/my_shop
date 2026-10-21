/**
 * Expense category choice optimised for daily use: big tiles for the usual heads (rent,
 * electricity, salaries, transport, tea & snacks, repairs, phone, packing, others —
 * EXPENSE_QUICK_TILES resolved against the chart with resolveExpenseTile), a searchable picker
 * for every other expense head, and "New category" (POST /accounts, an expense head). A tile
 * whose head does not exist yet (Tea & snacks) creates it on first tap.
 */
import {
  Coffee,
  Ellipsis,
  Home,
  Package,
  Phone,
  Plus,
  Truck,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type AccountBalance,
  EXPENSE_QUICK_TILES,
  resolveExpenseTile,
} from '@kadai/shared/api/accounting'
import { AccountPicker } from '@/components/pickers'
import { Button, FormField, Input, Skeleton } from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useChartOfAccounts, useCreateAccount } from '../api'
import { notifyAccountingError } from '../lib/errors'
import { accountName, bi } from '../lib/labels'

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  zap: Zap,
  users: Users,
  truck: Truck,
  coffee: Coffee,
  wrench: Wrench,
  phone: Phone,
  package: Package,
  ellipsis: Ellipsis,
}

/** The chart query the tiles and the expense AccountPicker share (same cache entry). */
const EXPENSE_HEADS_QUERY = { balances: false, type: ['expense' as const] }

export function ExpenseCategoryTiles({
  value,
  onChange,
  storeId,
  error,
}: {
  value: string | null
  onChange: (accountId: string | null, account: AccountBalance | null) => void
  storeId?: string | null
  error?: string
}) {
  const { t } = useTranslation(['accounting', 'common'])
  const canCreate = useCan(['accounting.write', 'expenses.write'])
  const chart = useChartOfAccounts(EXPENSE_HEADS_QUERY)
  const create = useCreateAccount()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [nameTa, setNameTa] = useState('')
  const [pendingTile, setPendingTile] = useState<string | null>(null)

  const accounts = useMemo(
    () =>
      (chart.data?.data.accounts ?? []).filter(
        (a) => a.is_active && (!storeId || a.store_id === null || a.store_id === storeId),
      ),
    [chart.data, storeId],
  )
  const tiles = useMemo(
    () =>
      EXPENSE_QUICK_TILES.map((tile) => ({ tile, account: resolveExpenseTile(tile, accounts) })),
    [accounts],
  )
  const tileAccountIds = new Set(tiles.map((x) => x.account?.id).filter(Boolean))
  const selectedIsOther = Boolean(value && !tileAccountIds.has(value))

  const createHead = (input: { name: string; name_ta: string | null }, tileKey?: string): void => {
    setPendingTile(tileKey ?? null)
    create.mutate(
      { body: { type: 'expense', name: input.name, name_ta: input.name_ta } },
      {
        onSuccess: (res) => {
          onChange(res.data.id, res.data)
          setAdding(false)
          setName('')
          setNameTa('')
        },
        onError: notifyAccountingError,
        onSettled: () => setPendingTile(null),
      },
    )
  }

  if (chart.isPending) {
    return (
      <div className="grid grid-cols-3 gap-2" aria-busy>
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-[4.5rem] rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="radiogroup"
        aria-label={t('expenses.form.category')}
        aria-invalid={Boolean(error) || undefined}
        className="grid grid-cols-3 gap-2"
      >
        {tiles.map(({ tile, account }) => {
          const Icon = ICONS[tile.icon] ?? Ellipsis
          const selected = Boolean(account && account.id === value)
          const creatable = !account && tile.suggestion !== null && canCreate
          const disabled = !account && !creatable
          return (
            <button
              key={tile.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || create.isPending}
              title={account ? accountName(account) : undefined}
              onClick={() => {
                if (account) onChange(account.id, account)
                else if (creatable && tile.suggestion)
                  createHead({ name: tile.suggestion, name_ta: tile.ta }, tile.key)
              }}
              className={cn(
                'flex min-h-[4.5rem] flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center text-xs font-medium leading-tight transition-colors sm:text-sm',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                selected
                  ? 'border-primary bg-primary-soft text-primary-soft-foreground shadow-card'
                  : 'border-border bg-surface hover:border-primary/50 hover:bg-surface-2',
                disabled && 'opacity-50',
                pendingTile === tile.key && 'animate-pulse',
              )}
            >
              <Icon
                className={cn('size-5', selected ? 'text-primary' : 'text-muted-foreground')}
                aria-hidden
              />
              <span className="line-clamp-2">{bi(tile)}</span>
            </button>
          )
        })}
      </div>
      <div className="flex flex-col gap-1">
        <div className="min-w-0">
          <AccountPicker
            value={selectedIsOther ? value : null}
            onChange={(id, account) => onChange(id, account)}
            types={['expense']}
            storeId={storeId}
            placeholder={t('expenses.form.other_category')}
            aria-label={t('expenses.form.other_category')}
          />
        </div>
        {canCreate ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Plus />}
            onClick={() => setAdding((v) => !v)}
            aria-expanded={adding}
            className="self-start"
          >
            {t('expenses.form.new_category')}
          </Button>
        ) : null}
      </div>
      {adding ? (
        <div className="grid gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <FormField label={t('expenses.form.new_category_name')} required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </FormField>
          <FormField label={t('common:fields.name_ta')} optional>
            <Input value={nameTa} onChange={(e) => setNameTa(e.target.value)} maxLength={120} />
          </FormField>
          <Button
            variant="secondary"
            loading={create.isPending && pendingTile === null}
            disabled={!name.trim()}
            onClick={() => createHead({ name: name.trim(), name_ta: nameTa.trim() || null })}
          >
            {t('common:actions.add')}
          </Button>
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
