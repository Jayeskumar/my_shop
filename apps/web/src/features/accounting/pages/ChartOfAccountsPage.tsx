/**
 * Chart of accounts (/accounting/accounts): every account as a tree under its type (assets,
 * liabilities, capital, income, expenses) with its balance as of a date — parents show the roll-up
 * of their children (buildAccountTree). Search by code or either name, show inactive accounts,
 * filter balances by store. Add custom accounts (expense heads, a second bank or cash account),
 * rename any account, deactivate / delete custom ones; every account opens its ledger.
 */
import { ChevronRight, ListTree, Pencil, Plus } from 'lucide-react'
import { Fragment, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  type AccountBalance,
  type AccountTreeNode,
  buildAccountTree,
} from '@kadai/shared/api/accounting'
import type { AccountType } from '@kadai/shared'
import { AccountTypeSchema } from '@kadai/shared/enums'
import { StorePicker } from '@/components/pickers'
import {
  Badge,
  Button,
  DatePicker,
  EmptyState,
  ErrorFallback,
  IconButton,
  PageHeader,
  SearchInput,
  Skeleton,
  Switch,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useChartOfAccounts } from '../api'
import { AccountFormDialog } from '../components/AccountFormDialog'
import { accountName, accountTypeLabel, drCrText } from '../lib/labels'
import { useTenantInfo } from '../lib/tenant'
import { useUrlState } from '../lib/url-state'

type Node = AccountTreeNode<AccountBalance>

function matches(a: AccountBalance, q: string): boolean {
  const hay = `${a.code} ${a.name} ${a.name_ta ?? ''}`.toLocaleLowerCase()
  return q
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term))
}

/** Keeps nodes that match or have a matching descendant. */
function filterTree(nodes: Node[], q: string): Node[] {
  if (!q.trim()) return nodes
  return nodes.flatMap((n) => {
    const children = filterTree(n.children, q)
    return matches(n, q) || children.length ? [{ ...n, children }] : []
  })
}

export default function ChartOfAccountsPage() {
  const { t } = useTranslation(['accounting', 'common'])
  const tenant = useTenantInfo()
  const canCreate = useCan(['accounting.write', 'expenses.write'])
  const canEdit = useCan('accounting.write')
  const url = useUrlState()
  const asOf = url.date('as_of', tenant.today)
  const storeId = url.id('store')
  const includeInactive = url.get('inactive') === '1'
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [dialog, setDialog] = useState<{
    accountId: string | null
    parent: AccountBalance | null
    type?: AccountType
  } | null>(null)

  const chart = useChartOfAccounts({
    as_of: asOf,
    ...(storeId ? { store_id: storeId } : {}),
    ...(includeInactive ? { include_inactive: true } : {}),
  })
  const accounts = useMemo(() => chart.data?.data.accounts ?? [], [chart.data])
  const totals = useMemo(() => chart.data?.data.totals ?? [], [chart.data])

  const sections = useMemo(
    () =>
      AccountTypeSchema.options.map((type) => ({
        type,
        nodes: filterTree(buildAccountTree(accounts.filter((a) => a.type === type)), q),
        total: totals.find((x) => x.type === type)?.balance_paise ?? null,
      })),
    [accounts, totals, q],
  )

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** `spacer`: the section has collapsible parents, so leaves keep the toggle's column. */
  const renderNodes = (nodes: Node[], spacer: boolean): ReactNode =>
    nodes.map((n) => {
      const hasChildren = n.children.length > 0
      const open = q.trim() !== '' || !collapsed.has(n.id)
      const balance = hasChildren ? n.rollup_balance_paise : (n.balance_paise ?? 0)
      return (
        <Fragment key={n.id}>
          <li
            className={cn(
              'flex items-center gap-2 border-b border-border/60 py-1.5 pe-2',
              !n.is_active && 'opacity-60',
            )}
            style={{ paddingInlineStart: `${(spacer ? 0.5 : 1) + n.depth * 1.25}rem` }}
          >
            {hasChildren ? (
              <IconButton
                icon={<ChevronRight className={cn('transition-transform', open && 'rotate-90')} />}
                label={
                  open
                    ? t('accounts.collapse', { name: accountName(n) })
                    : t('accounts.expand', { name: accountName(n) })
                }
                size="sm"
                tooltip={false}
                onClick={() => toggle(n.id)}
                aria-expanded={open}
              />
            ) : spacer ? (
              <span className="inline-block w-8 shrink-0" aria-hidden />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs tabular-nums text-muted-foreground">{n.code}</span>
                <Link
                  to={`/accounting/ledgers?account=${n.id}${n.money_kind ? '&book=cash' : ''}`}
                  className={cn(
                    'truncate underline-offset-4 hover:text-primary hover:underline',
                    hasChildren ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {accountName(n)}
                </Link>
                {!n.is_system ? (
                  <Badge size="sm" tone="accent" appearance="outline">
                    {t('accounts.custom')}
                  </Badge>
                ) : null}
                {n.money_kind ? (
                  <Badge size="sm" tone="info">
                    {t(n.money_kind === 'cash' ? 'accounts.cash' : 'accounts.bank')}
                  </Badge>
                ) : null}
                {n.store_id ? (
                  <Badge size="sm" tone="accent">
                    {tenant.stores.find((s) => s.id === n.store_id)?.code ??
                      t('accounts.store_only')}
                  </Badge>
                ) : null}
                {!n.is_active ? (
                  <Badge size="sm" tone="danger">
                    {t('common:status.inactive')}
                  </Badge>
                ) : null}
              </div>
              {n.name_ta && accountName(n) !== n.name ? (
                <div className="truncate text-xs text-muted-foreground">{n.name}</div>
              ) : n.name_ta && accountName(n) !== n.name_ta ? (
                <div className="truncate text-xs text-muted-foreground" lang="ta">
                  {n.name_ta}
                </div>
              ) : null}
            </div>
            <span
              className={cn(
                'shrink-0 text-end text-sm tabular-nums',
                hasChildren && 'font-semibold',
                balance < 0 && 'text-danger',
              )}
            >
              {drCrText(n.type, balance)}
            </span>
            {canEdit ? (
              <IconButton
                icon={<Pencil />}
                label={t('accounts.edit', { name: accountName(n) })}
                size="sm"
                onClick={() => setDialog({ accountId: n.id, parent: null })}
              />
            ) : null}
          </li>
          {hasChildren && open ? renderNodes(n.children, spacer) : null}
        </Fragment>
      )
    })

  const empty = sections.every((s) => s.nodes.length === 0)

  return (
    <div>
      <PageHeader
        title={t('accounts.title')}
        description={t('accounts.description')}
        backTo="/accounting/ledgers"
        actions={
          canCreate ? (
            <Button
              leftIcon={<Plus />}
              onClick={() => setDialog({ accountId: null, parent: null })}
            >
              {t('accounts.add')}
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:flex-wrap sm:items-center">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={t('accounts.search_placeholder')}
          wrapperClassName="sm:max-w-xs sm:flex-1"
        />
        <DatePicker
          value={asOf}
          onChange={(d) => url.set({ as_of: d && d !== tenant.today ? d : null })}
          max={tenant.today}
          aria-label={t('accounts.as_of')}
          className="w-44"
        />
        {tenant.multiStore ? (
          <StorePicker
            value={storeId ?? 'all'}
            onChange={(id) => url.set({ store: id && id !== 'all' ? id : null })}
            allowAll
            clearable={false}
            className="sm:w-52"
            aria-label={t('common:fields.store')}
          />
        ) : null}
        <Switch
          checked={includeInactive}
          onCheckedChange={(v) => url.set({ inactive: v ? '1' : null })}
          label={t('accounts.show_inactive')}
        />
      </div>

      {chart.error ? (
        <ErrorFallback error={chart.error} reset={() => void chart.refetch()} />
      ) : chart.isPending ? (
        <div className="flex flex-col gap-3" aria-busy>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : empty ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<ListTree />}
            title={t('accounts.none')}
            description={t('accounts.none_hint')}
          />
        </div>
      ) : (
        <div className={cn('flex flex-col gap-4', chart.isFetching && 'opacity-70')}>
          {sections.map((s) =>
            s.nodes.length ? (
              <section
                key={s.type}
                className="overflow-hidden rounded-xl border border-border bg-surface"
                aria-label={accountTypeLabel(s.type)}
              >
                <header className="flex items-center justify-between gap-3 bg-surface-2/70 px-4 py-2.5">
                  <h2 className="text-sm font-semibold">{accountTypeLabel(s.type)}</h2>
                  <div className="flex items-center gap-1">
                    {s.total !== null ? (
                      <span className="text-sm font-semibold tabular-nums">
                        {drCrText(s.type, s.total)}
                      </span>
                    ) : null}
                    {canEdit || (canCreate && s.type === 'expense') ? (
                      <IconButton
                        icon={<Plus />}
                        label={t('accounts.add_type', { type: accountTypeLabel(s.type) })}
                        size="sm"
                        onClick={() => setDialog({ accountId: null, parent: null, type: s.type })}
                      />
                    ) : null}
                  </div>
                </header>
                <ul>
                  {renderNodes(
                    s.nodes,
                    s.nodes.some((n) => n.children.length > 0),
                  )}
                </ul>
              </section>
            ) : null,
          )}
        </div>
      )}

      <AccountFormDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        accountId={dialog?.accountId ?? null}
        parent={dialog?.parent ?? null}
        defaultType={dialog?.type}
        existing={accounts}
      />
    </div>
  )
}
