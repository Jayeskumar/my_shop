/**
 * Customers & khata list (/parties/customers): quick filter chips (all, with due, overdue,
 * credit balance, wholesale, inactive), search by name / mobile / GSTIN / code, tag filter,
 * server sorting and paging kept in the URL. Rows open the khata page; phones are tap-to-call
 * with a WhatsApp shortcut. Below md the table becomes cards.
 */
import { BookOpenText, Hash, Plus, Upload, UsersRound, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import {
  CUSTOMER_TYPE_LABELS,
  type CustomerListItem,
  type CustomerListQuery,
} from '@kadai/shared/api/parties'
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Kbd,
  PageHeader,
  PhoneLink,
  SearchInput,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { formatDate, formatMoney, formatRelative } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useCustomers } from '../api'
import { BalanceAmount } from '../components/BalanceAmount'
import { CustomerFormDialog } from '../components/CustomerFormDialog'
import { CustomerImportDialog } from '../components/CustomerImportDialog'
import { FilterChips } from '../components/FilterChips'
import { partyNames, pickLabel, PARTIES_HOTKEY_SCOPE } from '../lib/labels'
import { LIST_PAGE_SIZES, useListState } from '../lib/use-list-state'

const FILTERS = ['all', 'due', 'overdue', 'credit', 'wholesale', 'inactive'] as const
type CustomerFilter = (typeof FILTERS)[number]
const SORTS = ['name', 'balance_paise', 'last_invoice_at', 'created_at'] as const

function filterQuery(filter: CustomerFilter): Partial<CustomerListQuery> {
  switch (filter) {
    case 'due':
      return { has_due: true }
    case 'overdue':
      return { overdue: true }
    case 'credit':
      return { credit: true }
    case 'wholesale':
      return { customer_type: 'wholesale' }
    case 'inactive':
      return { is_active: false }
    case 'all':
      return {}
  }
}

const WEEK_MS = 7 * 86_400_000

export default function CustomersPage() {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const navigate = useNavigate()
  const canWrite = useCan('customers.write')
  const searchRef = useRef<HTMLInputElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [state, setState] = useListState<CustomerFilter>({
    filter: 'all',
    filters: FILTERS,
    sort: 'name',
    sorts: SORTS,
  })

  const query: CustomerListQuery = {
    limit: state.limit,
    offset: state.offset,
    sort: state.sort,
    ...(state.q ? { q: state.q } : {}),
    ...(state.tag ? { tag: state.tag } : {}),
    is_active: true,
    ...filterQuery(state.filter),
  }
  const list = useCustomers(query)
  const rows = list.data?.data ?? []
  const page = list.data?.page
  const filtered = state.filter !== 'all' || Boolean(state.q) || Boolean(state.tag)

  useHotkeyScope(PARTIES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) setAddOpen(true)
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PARTIES_HOTKEY_SCOPE },
  )

  const columns = useMemo<DataTableColumn<CustomerListItem>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('fields.name'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => <NameCell customer={row.original} language={i18n.language} />,
      },
      {
        id: 'phone',
        header: t('fields.phone'),
        enableSorting: false,
        meta: { mobile: 'subtitle' },
        cell: ({ row }) => <PhoneLink phone={row.original.phone} whatsapp />,
      },
      {
        id: 'balance_paise',
        accessorKey: 'balance_paise',
        header: t('customers.col_balance'),
        enableSorting: true,
        meta: { align: 'right', label: t('customers.col_balance') },
        cell: ({ row }) => (
          <div className="flex flex-col items-end gap-0.5">
            <BalanceAmount partyType="customer" balancePaise={row.original.balance_paise} />
            {row.original.overdue_paise > 0 ? (
              <Badge tone="danger" size="sm">
                {t('customers.overdue_amount', {
                  amount: formatMoneyShort(row.original.overdue_paise),
                })}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: 'last_invoice_at',
        accessorKey: 'last_invoice_at',
        header: t('customers.col_last_visit'),
        enableSorting: true,
        meta: { label: t('customers.col_last_visit') },
        cell: ({ row }) => <LastVisit at={row.original.last_invoice_at} />,
      },
      {
        id: 'tags',
        header: t('fields.tags'),
        enableSorting: false,
        meta: { label: t('fields.tags') },
        cell: ({ row }) => (
          <TagList
            customer={row.original}
            language={i18n.language}
            onTag={(tag) => setState({ tag })}
          />
        ),
      },
    ],
    [t, i18n.language, setState],
  )

  const chips = FILTERS.map((key) => ({
    key,
    label: t(`customers.filter_${key}`),
    tone:
      key === 'overdue' ? ('danger' as const) : key === 'credit' ? ('success' as const) : undefined,
  }))

  const firstRun = !filtered && !list.isLoading && !list.error && page?.total === 0

  return (
    <div>
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        actions={
          canWrite ? (
            <>
              <Button
                variant="outline"
                leftIcon={<Upload />}
                onClick={() => setImportOpen(true)}
                aria-label={t('customers.import')}
              >
                <span className="hidden sm:inline">{t('customers.import')}</span>
              </Button>
              <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
                {t('customers.add')}
                <Kbd
                  combo="alt+n"
                  className="ms-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground lg:inline-flex"
                />
              </Button>
            </>
          ) : null
        }
      />

      <div className="flex flex-col gap-3 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchInput
            ref={searchRef}
            value={state.q}
            onChange={(q) => setState({ q })}
            placeholder={t('customers.search_placeholder')}
            wrapperClassName="sm:max-w-sm"
          />
          {state.tag ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Hash />}
              rightIcon={<X />}
              onClick={() => setState({ tag: '' })}
              aria-label={t('customers.clear_tag', { tag: state.tag })}
            >
              {state.tag}
            </Button>
          ) : null}
        </div>
        <FilterChips
          chips={chips}
          value={state.filter}
          onChange={(filter) => setState({ filter })}
          label={t('customers.filters_label')}
        />
      </div>

      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<BookOpenText />}
            title={t('customers.empty_title')}
            description={t('customers.empty_description')}
            action={
              canWrite ? (
                <>
                  <Button leftIcon={<Plus />} onClick={() => setAddOpen(true)}>
                    {t('customers.add_first')}
                  </Button>
                  <Button
                    variant="outline"
                    leftIcon={<Upload />}
                    onClick={() => setImportOpen(true)}
                  >
                    {t('customers.import_from_file')}
                  </Button>
                </>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('customers.title')}
          columns={columns}
          data={rows}
          getRowId={(c) => c.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={(c) => navigate(`/parties/customers/${c.id}`)}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? 'name' })}
          pagination={
            page
              ? {
                  ...page,
                  pageSizeOptions: LIST_PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          renderCard={(c) => (
            <CustomerCard
              customer={c}
              language={i18n.language}
              onTag={(tag) => setState({ tag })}
            />
          )}
          empty={
            <EmptyState
              compact
              icon={<UsersRound />}
              title={t(`customers.none_${state.filter}`)}
              description={t('customers.none_hint')}
            />
          }
        />
      )}

      <CustomerFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(c) => navigate(`/parties/customers/${c.id}`)}
      />
      <CustomerImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  )
}

function formatMoneyShort(paise: number): string {
  return formatMoney(paise, { decimals: 'auto' })
}

function NameCell({ customer, language }: { customer: CustomerListItem; language: string }) {
  const { t } = useTranslation(['parties', 'common'])
  const names = partyNames(customer.name, customer.name_ta, language)
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={names.primary} size="sm" />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{names.primary}</span>
          {!customer.is_active ? <Badge size="sm">{t('common:status.inactive')}</Badge> : null}
        </div>
        {names.secondary || customer.code ? (
          <div className="truncate text-xs text-muted-foreground">
            {[names.secondary, customer.code].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function LastVisit({ at }: { at: string | null }) {
  const { t, i18n } = useTranslation('parties')
  if (!at)
    return <span className="text-sm text-muted-foreground">{t('customers.never_visited')}</span>
  const recent = Date.now() - new Date(at).getTime() < WEEK_MS
  return (
    <span className="text-sm" title={formatDate(at)}>
      {recent ? formatRelative(at, i18n.language === 'en' ? 'en' : 'ta') : formatDate(at)}
    </span>
  )
}

function TagList({
  customer,
  language,
  onTag,
}: {
  customer: CustomerListItem
  language: string
  onTag: (tag: string) => void
}) {
  const typeBadge =
    customer.customer_type !== 'retail' ? (
      <Badge tone="info" size="sm">
        {pickLabel(CUSTOMER_TYPE_LABELS[customer.customer_type], language)}
      </Badge>
    ) : null
  if (!typeBadge && customer.tags.length === 0)
    return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap items-center gap-1">
      {typeBadge}
      {customer.tags.slice(0, 3).map((tag) => (
        <button
          key={tag}
          type="button"
          className="rounded-full focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(e) => {
            e.stopPropagation()
            onTag(tag)
          }}
        >
          <Badge size="sm" appearance="outline" className="hover:border-primary hover:text-primary">
            #{tag}
          </Badge>
        </button>
      ))}
      {customer.tags.length > 3 ? (
        <span className="text-xs text-muted-foreground">+{customer.tags.length - 3}</span>
      ) : null}
    </div>
  )
}

function CustomerCard({
  customer,
  language,
  onTag,
}: {
  customer: CustomerListItem
  language: string
  onTag: (tag: string) => void
}) {
  const { t } = useTranslation('parties')
  const names = partyNames(customer.name, customer.name_ta, language)
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <Avatar name={names.primary} size="md" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{names.primary}</div>
          {names.secondary ? (
            <div className="truncate text-xs text-muted-foreground">{names.secondary}</div>
          ) : null}
        </div>
        <div className="max-w-[45%] text-end">
          <BalanceAmount partyType="customer" balancePaise={customer.balance_paise} />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ps-12 text-sm">
        <PhoneLink phone={customer.phone} whatsapp />
        {customer.overdue_paise > 0 ? (
          <Badge tone="danger" size="sm">
            {t('customers.overdue_amount', { amount: formatMoneyShort(customer.overdue_paise) })}
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 ps-12">
        <TagList customer={customer} language={language} onTag={onTag} />
        <span className="text-xs text-muted-foreground">
          <LastVisit at={customer.last_invoice_at} />
        </span>
      </div>
    </div>
  )
}
