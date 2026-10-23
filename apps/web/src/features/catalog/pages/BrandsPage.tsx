/**
 * Brands (GET /brands): search, inline add (Enter), inline rename (Enter saves, Esc cancels),
 * active switch, delete an unused brand (409 in use → offer to deactivate), product counts.
 */
import { type Brand, BrandCreateSchema, catalogRoutes } from '@kadai/shared/api/catalog'
import { keepPreviousData } from '@tanstack/react-query'
import { Check, Pencil, Plus, Tags, Trash2, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import {
  Badge,
  Button,
  type DataTableColumn,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  SearchInput,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { useCan } from '@/lib/auth'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { catalogReasonText, isInUseConflict } from '../lib/messages'

const PAGE = 50

export default function BrandsPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const canWrite = useCan('catalog.write')
  const confirm = useConfirm()
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState<string | null>('name')
  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const list = useRouteQuery(
    catalogRoutes.listBrands,
    { query: { ...(q ? { q } : {}), limit: PAGE, offset, sort: sort ?? 'name' } },
    { placeholderData: keepPreviousData },
  )
  const create = useRouteMutation(catalogRoutes.createBrand, {
    invalidates: [catalogRoutes.listBrands],
    onError: (error) =>
      setAddError(
        catalogReasonText(error) ??
          (error.code === 'DUPLICATE' ? t('brands.duplicate') : error.message),
      ),
  })
  const update = useRouteMutation(catalogRoutes.updateBrand, {
    invalidates: [catalogRoutes.listBrands],
    onError: (error) =>
      notify.error(
        catalogReasonText(error) ?? (error.code === 'DUPLICATE' ? t('brands.duplicate') : error),
      ),
  })
  const del = useRouteMutation(catalogRoutes.deleteBrand, {
    invalidates: [catalogRoutes.listBrands],
    meta: { errorToast: false },
  })

  const add = (): void => {
    const parsed = BrandCreateSchema.safeParse({ name: newName })
    if (!parsed.success) {
      setAddError(t('brands.name_required'))
      return
    }
    create.mutate(
      { body: parsed.data },
      {
        onSuccess: (res) => {
          notify.success(t('brands.created', { name: res.data.name }))
          setNewName('')
          setAddError(null)
        },
      },
    )
  }

  const saveEdit = (b: Brand): void => {
    const name = editName.trim()
    if (!name || name === b.name) {
      setEditId(null)
      return
    }
    update.mutate(
      { params: { id: b.id }, body: { name, if_updated_at: b.updated_at } },
      {
        onSuccess: () => {
          notify.success(t('brands.saved', { name }))
          setEditId(null)
        },
      },
    )
  }

  const remove = async (b: Brand): Promise<void> => {
    const ok = await confirm({
      title: t('brands.delete_title', { name: b.name }),
      description: t('brands.delete_description'),
      tone: 'danger',
      confirmLabel: t('common:actions.delete'),
    })
    if (!ok) return
    try {
      await del.mutateAsync({ params: { id: b.id } })
      notify.success(t('brands.deleted', { name: b.name }))
    } catch (error) {
      if (!isInUseConflict(error)) {
        notify.error(error)
        return
      }
      const deactivate = await confirm({
        title: t('brands.in_use_title', { name: b.name }),
        description: t('brands.in_use_description', { count: b.product_count }),
        confirmLabel: t('brands.deactivate'),
      })
      if (deactivate)
        update.mutate(
          { params: { id: b.id }, body: { is_active: false, if_updated_at: b.updated_at } },
          { onSuccess: () => notify.success(t('brands.deactivated', { name: b.name })) },
        )
    }
  }

  const editKey = (e: KeyboardEvent<HTMLInputElement>, b: Brand): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveEdit(b)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditId(null)
    }
  }

  const nameCell = (b: Brand): ReactNode =>
    editId === b.id ? (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Input
          size="sm"
          value={editName}
          autoFocus
          maxLength={100}
          aria-label={t('brands.rename', { name: b.name })}
          onChange={(e) => setEditName(e.target.value)}
          onKeyDown={(e) => editKey(e, b)}
        />
        <IconButton
          icon={<Check />}
          label={t('common:actions.save')}
          size="sm"
          variant="ghost"
          onClick={() => saveEdit(b)}
          loading={update.isPending}
        />
        <IconButton
          icon={<X />}
          label={t('common:actions.cancel')}
          size="sm"
          variant="ghost"
          onClick={() => setEditId(null)}
        />
      </div>
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium">{b.name}</span>
        {!b.is_active ? (
          <Badge tone="neutral" appearance="outline" size="sm">
            {t('common:status.inactive')}
          </Badge>
        ) : null}
      </span>
    )

  const productsLink = (b: Brand, withLabel: boolean): ReactNode => (
    <Link
      to={`/catalog/products?brand_id=${b.id}&brand_name=${encodeURIComponent(b.name)}`}
      className="tabular-nums hover:underline"
    >
      {withLabel ? t('brands.product_count', { count: b.product_count }) : b.product_count}
    </Link>
  )

  const activeSwitch = (b: Brand): ReactNode => (
    <Switch
      checked={b.is_active}
      aria-label={t('brands.active_of', { name: b.name })}
      onCheckedChange={(on) =>
        update.mutate({
          params: { id: b.id },
          body: { is_active: on, if_updated_at: b.updated_at },
        })
      }
    />
  )

  const actionButtons = (b: Brand): ReactNode => (
    <div className="flex justify-end gap-1">
      <IconButton
        icon={<Pencil />}
        label={t('brands.rename', { name: b.name })}
        variant="ghost"
        size="sm"
        onClick={() => {
          setEditId(b.id)
          setEditName(b.name)
        }}
      />
      <IconButton
        icon={<Trash2 />}
        label={t('brands.delete', { name: b.name })}
        variant="ghost"
        size="sm"
        onClick={() => void remove(b)}
      />
    </div>
  )

  const columns = useMemo<DataTableColumn<Brand>[]>(
    () => [
      {
        id: 'name',
        header: t('fields.brand'),
        enableSorting: true,
        cell: ({ row }) => nameCell(row.original),
      },
      {
        id: 'product_count',
        header: t('brands.products'),
        enableSorting: true,
        meta: { align: 'right' },
        cell: ({ row }) => productsLink(row.original, false),
      },
      ...(canWrite
        ? [
            {
              id: 'active',
              header: t('common:status.active'),
              enableSorting: false,
              meta: { align: 'center' as const },
              cell: ({ row }: { row: { original: Brand } }) => activeSwitch(row.original),
            },
            {
              id: 'actions',
              header: '',
              enableSorting: false,
              meta: { align: 'right' as const, label: t('brands.actions') },
              cell: ({ row }: { row: { original: Brand } }) => actionButtons(row.original),
            } satisfies DataTableColumn<Brand>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cell renderers read the latest state
    [t, canWrite, editId, editName, update.isPending],
  )

  const renderCard = (b: Brand): ReactNode => (
    <div className="grid grid-cols-1 gap-1.5">
      {nameCell(b)}
      {editId === b.id ? null : (
        <div className="flex items-center justify-between gap-2 text-sm">
          {productsLink(b, true)}
          {canWrite ? (
            <div className="flex items-center gap-2">
              {activeSwitch(b)}
              {actionButtons(b)}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )

  const page = list.data?.page
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t('pages.brands')} description={t('brands.description')} />
      {canWrite ? (
        <form
          className="mb-4 grid grid-cols-1 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setAddError(null)
              }}
              placeholder={t('brands.add_placeholder')}
              aria-label={t('brands.add_label')}
              maxLength={100}
              size="lg"
              aria-invalid={addError ? true : undefined}
            />
            <Button type="submit" size="lg" leftIcon={<Plus />} loading={create.isPending}>
              {t('common:actions.add')}
            </Button>
          </div>
          {addError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {addError}
            </p>
          ) : null}
        </form>
      ) : null}
      <div className="mb-3">
        <SearchInput
          value={q}
          onChange={(v) => {
            setQ(v)
            setOffset(0)
          }}
          placeholder={t('brands.search')}
          wrapperClassName="sm:max-w-xs"
        />
      </div>
      <DataTable<Brand>
        label={t('pages.brands')}
        columns={columns}
        data={list.data?.data ?? []}
        getRowId={(b) => b.id}
        renderCard={renderCard}
        loading={list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        sort={sort}
        onSortChange={(s) => {
          setSort(s)
          setOffset(0)
        }}
        pagination={page ? { ...page, onChange: (n) => setOffset(n.offset) } : undefined}
        empty={
          q ? undefined : (
            <EmptyState
              compact
              icon={<Tags />}
              title={t('brands.empty_title')}
              description={t('brands.empty_description')}
            />
          )
        }
      />
    </div>
  )
}
