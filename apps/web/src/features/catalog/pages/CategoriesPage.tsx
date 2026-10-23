/**
 * Categories (GET /categories tree): expand / collapse, search in both languages, add a
 * sub-category (max 3 levels), edit names (en / ta), parent and tax defaults (HSN, GST, price-slab
 * rule), deactivate, delete an unused one (409 in use → offer to deactivate), product counts.
 */
import {
  type CategoryCreate,
  CategoryCreateSchema,
  type CategoryNode,
  type CategoryUpdate,
  CategoryUpdateSchema,
  MAX_CATEGORY_DEPTH,
  catalogRoutes,
  categoryPlacementIssue,
  flattenCategoryTree,
} from '@kadai/shared/api/catalog'
import type { GstRateBp } from '@kadai/shared/gst'
import { formatBp } from '@kadai/shared/money'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  FolderTree,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  EyeOff,
  Eye,
} from 'lucide-react'
import { type CSSProperties, type FormEvent, type ReactNode, useMemo, useState } from 'react'
import {
  Controller,
  type FieldErrors,
  FormProvider,
  type Resolver,
  set,
  useForm,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { CategoryPicker } from '@/components/pickers'
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  NumberInput,
  PageHeader,
  SearchInput,
  Skeleton,
  Switch,
  notify,
  useConfirm,
} from '@/components/ui'
import { callRoute } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { invalidateRoutes, useRouteQuery } from '@/lib/query'
import { useQueryClient } from '@tanstack/react-query'
import { Field } from '../components/Field'
import { GstRateSelect, HsnCombobox, SlabRuleSelect } from '../components/TaxInputs'
import { matchesSearch } from '../lib/format'
import { catalogReasonText, isInUseConflict } from '../lib/messages'

interface CategoryFormValues {
  name: string
  name_ta: string
  parent_id: string | null
  hsn_code: string
  gst_rate_bp: number | null
  tax_slab_rule_id: string | null
  sort_order: number | null
  is_active: boolean
}

type Editing = { mode: 'create'; parentId: string | null } | { mode: 'edit'; node: CategoryNode }

/** Products in the category and all its sub-categories (what its products link shows). */
function subtreeCount(node: CategoryNode): number {
  return node.children.reduce((n, c) => n + subtreeCount(c), node.product_count)
}

function bodyOf(v: CategoryFormValues): CategoryCreate {
  return {
    name: v.name.trim(),
    name_ta: v.name_ta.trim() || null,
    parent_id: v.parent_id,
    hsn_code: v.hsn_code.trim() || null,
    gst_rate_bp: v.gst_rate_bp as GstRateBp | null,
    tax_slab_rule_id: v.tax_slab_rule_id,
    sort_order: v.sort_order ?? 0,
  }
}

function resolverFor(
  rows: readonly CategoryNode[],
  editingId: string | null,
): Resolver<CategoryFormValues> {
  return (values) => {
    const errors: FieldErrors<CategoryFormValues> = {}
    const parsed = (editingId ? CategoryUpdateSchema : CategoryCreateSchema).safeParse(
      editingId ? { ...bodyOf(values), is_active: values.is_active } : bodyOf(values),
    )
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join('.') || 'name'
        set(errors, path, { type: 'validate', message: issue.message })
      }
    const placement = categoryPlacementIssue(rows, editingId, values.parent_id)
    if (placement) set(errors, 'parent_id', { type: 'validate', message: placement })
    return Object.keys(errors).length ? { values: {}, errors } : { values, errors: {} }
  }
}

export default function CategoriesPage() {
  const { t } = useTranslation(['catalog', 'common'])
  const canWrite = useCan('catalog.write')
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const tree = useRouteQuery(catalogRoutes.listCategories, { query: {} })
  const roots = useMemo(() => (tree.data?.data ?? []) as CategoryNode[], [tree.data])
  const flat = useMemo(() => flattenCategoryTree(roots), [roots])
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Editing | null>(null)

  const refresh = (): Promise<void> => invalidateRoutes(queryClient, [catalogRoutes.listCategories])

  const visible = useMemo(() => {
    if (!q) return null
    const keep = new Set<string>()
    const byId = new Map(flat.map((c) => [c.id, c]))
    for (const c of flat) {
      if (!matchesSearch(q, c.name, c.name_ta, c.hsn_code)) continue
      let cur: CategoryNode | undefined = c
      while (cur) {
        keep.add(cur.id)
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
      }
    }
    return keep
  }, [q, flat])

  const remove = async (node: CategoryNode): Promise<void> => {
    const name = localizedName(node.name, node.name_ta)
    const ok = await confirm({
      title: t('categories.delete_title', { name }),
      description: t('categories.delete_description'),
      tone: 'danger',
      confirmLabel: t('common:actions.delete'),
    })
    if (!ok) return
    try {
      await callRoute(catalogRoutes.deleteCategory, { params: { id: node.id } })
      notify.success(t('categories.deleted', { name }))
      await refresh()
    } catch (error) {
      if (!isInUseConflict(error)) {
        notify.error(catalogReasonText(error) ?? error)
        return
      }
      const deactivate = await confirm({
        title: t('categories.in_use_title', { name }),
        description: t('categories.in_use_description', { count: node.product_count }),
        confirmLabel: t('categories.deactivate'),
      })
      if (deactivate) await setActive(node, false)
    }
  }

  const setActive = async (node: CategoryNode, active: boolean): Promise<void> => {
    try {
      await callRoute(catalogRoutes.updateCategory, {
        params: { id: node.id },
        body: { is_active: active, if_updated_at: node.updated_at },
      })
      notify.success(
        active
          ? t('categories.activated', { name: localizedName(node.name, node.name_ta) })
          : t('categories.deactivated', { name: localizedName(node.name, node.name_ta) }),
      )
      await refresh()
    } catch (error) {
      notify.error(error)
    }
  }

  const toggle = (id: string): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderNode = (node: CategoryNode): ReactNode => {
    if (visible && !visible.has(node.id)) return null
    const open = Boolean(visible) || !collapsed.has(node.id)
    const name = localizedName(node.name, node.name_ta)
    const other = name === node.name ? node.name_ta : node.name
    const hasKids = node.children.length > 0
    return (
      <li
        key={node.id}
        role="treeitem"
        aria-expanded={hasKids ? open : undefined}
        aria-level={node.depth}
      >
        <div
          className="group flex min-h-14 items-center gap-1.5 border-b border-border py-2 pe-1 ps-[calc(var(--depth)*0.875rem+0.25rem)] hover:bg-surface-2/60 sm:gap-2 sm:pe-3 sm:ps-[calc(var(--depth)*1.5rem+0.5rem)]"
          style={{ '--depth': node.depth - 1 } as CSSProperties}
        >
          {hasKids ? (
            <IconButton
              icon={open ? <ChevronDown /> : <ChevronRight />}
              label={open ? t('categories.collapse', { name }) : t('categories.expand', { name })}
              variant="ghost"
              size="sm"
              onClick={() => toggle(node.id)}
            />
          ) : (
            <span className="inline-block w-8" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{name}</span>
              {other ? <span className="text-sm text-muted-foreground">{other}</span> : null}
              {!node.is_active ? (
                <Badge tone="neutral" appearance="outline" size="sm">
                  {t('common:status.inactive')}
                </Badge>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {node.hsn_code ? <span className="font-mono">HSN {node.hsn_code}</span> : null}
              {node.gst_rate_bp !== null ? (
                <Badge tone="primary" size="sm">
                  GST {formatBp(node.gst_rate_bp)}
                </Badge>
              ) : null}
              {node.tax_slab_rule_id ? (
                <Badge tone="accent" size="sm">
                  {t('tax.by_price')}
                </Badge>
              ) : null}
              <Link
                to={`/catalog/products?category_id=${node.id}`}
                className="font-medium text-primary underline-offset-2 hover:underline sm:hidden"
              >
                {t('categories.products', { count: subtreeCount(node) })}
              </Link>
            </div>
          </div>
          <Link
            to={`/catalog/products?category_id=${node.id}`}
            className="hidden shrink-0 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium hover:bg-surface-3 sm:inline-flex"
          >
            {t('categories.products', { count: subtreeCount(node) })}
          </Link>
          {canWrite ? (
            <div className="flex shrink-0 items-center">
              {node.depth < MAX_CATEGORY_DEPTH ? (
                <IconButton
                  icon={<Plus />}
                  label={t('categories.add_child_of', { name })}
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ mode: 'create', parentId: node.id })}
                />
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton
                    icon={<MoreVertical />}
                    label={t('categories.actions_for', { name })}
                    variant="ghost"
                    size="sm"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={<Pencil />}
                    onSelect={() => setEditing({ mode: 'edit', node })}
                  >
                    {t('common:actions.edit')}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={node.is_active ? <EyeOff /> : <Eye />}
                    onSelect={() => void setActive(node, !node.is_active)}
                  >
                    {node.is_active ? t('categories.deactivate') : t('categories.activate')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    icon={<Trash2 />}
                    tone="danger"
                    onSelect={() => void remove(node)}
                  >
                    {t('common:actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
        {hasKids && open ? <ul role="group">{node.children.map(renderNode)}</ul> : null}
      </li>
    )
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t('pages.categories')}
        description={t('categories.description')}
        actions={
          canWrite ? (
            <Button
              leftIcon={<FolderPlus />}
              onClick={() => setEditing({ mode: 'create', parentId: null })}
            >
              {t('categories.add')}
            </Button>
          ) : null
        }
      />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder={t('categories.search')}
          wrapperClassName="sm:max-w-xs"
        />
        {roots.length ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())}>
              {t('categories.expand_all')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setCollapsed(new Set(flat.filter((c) => c.children.length).map((c) => c.id)))
              }
            >
              {t('categories.collapse_all')}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {tree.isPending ? (
          <div className="grid grid-cols-1 gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : roots.length === 0 ? (
          <EmptyState
            icon={<FolderTree />}
            title={t('categories.empty_title')}
            description={t('categories.empty_description')}
            action={
              canWrite ? (
                <Button
                  leftIcon={<FolderPlus />}
                  onClick={() => setEditing({ mode: 'create', parentId: null })}
                >
                  {t('categories.add')}
                </Button>
              ) : undefined
            }
          />
        ) : visible && visible.size === 0 ? (
          <EmptyState
            compact
            title={t('common:empty.no_results')}
            description={t('common:empty.no_results_hint')}
          />
        ) : (
          <ul role="tree" aria-label={t('pages.categories')}>
            {roots.map(renderNode)}
          </ul>
        )}
      </div>
      {editing ? (
        <CategoryDialog
          editing={editing}
          rows={flat}
          onClose={() => setEditing(null)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  )
}

function CategoryDialog({
  editing,
  rows,
  onClose,
  onSaved,
}: {
  editing: Editing
  rows: readonly CategoryNode[]
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation(['catalog', 'common'])
  const node = editing.mode === 'edit' ? editing.node : null
  const [saving, setSaving] = useState(false)
  const form = useForm<CategoryFormValues>({
    defaultValues: node
      ? {
          name: node.name,
          name_ta: node.name_ta ?? '',
          parent_id: node.parent_id,
          hsn_code: node.hsn_code ?? '',
          gst_rate_bp: node.gst_rate_bp,
          tax_slab_rule_id: node.tax_slab_rule_id,
          sort_order: node.sort_order,
          is_active: node.is_active,
        }
      : {
          name: '',
          name_ta: '',
          parent_id: editing.mode === 'create' ? editing.parentId : null,
          hsn_code: '',
          gst_rate_bp: null,
          tax_slab_rule_id: null,
          sort_order: 0,
          is_active: true,
        },
    resolver: resolverFor(rows, node?.id ?? null),
    mode: 'onTouched',
  })
  const parent = rows.find((r) => r.id === form.watch('parent_id'))

  const save = async (v: CategoryFormValues): Promise<void> => {
    setSaving(true)
    try {
      if (node) {
        const body: CategoryUpdate = {
          ...bodyOf(v),
          is_active: v.is_active,
          if_updated_at: node.updated_at,
        }
        await callRoute(catalogRoutes.updateCategory, { params: { id: node.id }, body })
        notify.success(t('categories.saved', { name: v.name }))
      } else {
        await callRoute(catalogRoutes.createCategory, { body: bodyOf(v) })
        notify.success(t('categories.created', { name: v.name }))
      }
      onSaved()
      onClose()
    } catch (error) {
      const reason = catalogReasonText(error)
      if (reason) form.setError('name', { type: 'server', message: reason })
      else notify.error(error)
    } finally {
      setSaving(false)
    }
  }

  const submit = (e: FormEvent): void => {
    void form.handleSubmit(save)(e)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      size="lg"
      dismissible={!form.formState.isDirty}
      title={
        node
          ? t('categories.edit_title')
          : parent
            ? t('categories.add_child_title', {
                parent: localizedName(parent.name, parent.name_ta),
              })
            : t('categories.add_title')
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form="catalog-category-form" loading={saving}>
            {node ? t('common:actions.save') : t('common:actions.create')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form
          id="catalog-category-form"
          onSubmit={submit}
          className="grid grid-cols-1 gap-4"
          noValidate
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="name" label={t('fields.name')} required>
              <Input
                {...form.register('name')}
                autoFocus
                maxLength={100}
                placeholder={t('categories.name_placeholder')}
              />
            </Field>
            <Field name="name_ta" label={t('fields.name_ta')} optional>
              <Input
                {...form.register('name_ta')}
                lang="ta"
                maxLength={100}
                placeholder={t('categories.name_ta_placeholder')}
              />
            </Field>
          </div>
          <Field
            name="parent_id"
            label={t('categories.parent')}
            optional
            hint={t('categories.parent_hint')}
          >
            <Controller
              control={form.control}
              name="parent_id"
              render={({ field }) => (
                <CategoryPicker
                  value={field.value}
                  onChange={(id) => field.onChange(id)}
                  excludeId={node?.id ?? null}
                  maxDepth={MAX_CATEGORY_DEPTH - 1}
                  includeInactive
                  placeholder={t('categories.top_level')}
                />
              )}
            />
          </Field>
          <fieldset className="grid grid-cols-1 gap-4 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-semibold">{t('categories.tax_defaults')}</legend>
            <p className="-mt-1 text-xs text-muted-foreground">
              {t('categories.tax_defaults_hint')}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="hsn_code" label={t('fields.hsn')} optional>
                <Controller
                  control={form.control}
                  name="hsn_code"
                  render={({ field }) => (
                    <HsnCombobox
                      value={field.value}
                      onChange={(code, entry) => {
                        field.onChange(code)
                        if (entry?.gst_rate_bp != null && form.getValues('gst_rate_bp') === null)
                          form.setValue('gst_rate_bp', entry.gst_rate_bp, { shouldDirty: true })
                      }}
                    />
                  )}
                />
              </Field>
              <Field name="gst_rate_bp" label={t('fields.gst_rate')} optional>
                <Controller
                  control={form.control}
                  name="gst_rate_bp"
                  render={({ field }) => (
                    <GstRateSelect
                      value={field.value}
                      onChange={field.onChange}
                      noneLabel={t('categories.not_set')}
                    />
                  )}
                />
              </Field>
            </div>
            <Field name="tax_slab_rule_id" label={t('fields.slab_rule')} optional>
              <Controller
                control={form.control}
                name="tax_slab_rule_id"
                render={({ field }) => (
                  <SlabRuleSelect value={field.value} onChange={field.onChange} />
                )}
              />
            </Field>
          </fieldset>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
            <Field
              name="sort_order"
              label={t('categories.sort_order')}
              optional
              hint={t('categories.sort_order_hint')}
            >
              <Controller
                control={form.control}
                name="sort_order"
                render={({ field }) => (
                  <NumberInput
                    value={field.value}
                    onChange={field.onChange}
                    min={0}
                    max={100_000}
                  />
                )}
              />
            </Field>
            {node ? (
              <Controller
                control={form.control}
                name="is_active"
                render={({ field }) => (
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    label={t('common:status.active')}
                  />
                )}
              />
            ) : null}
          </div>
        </form>
      </FormProvider>
    </Dialog>
  )
}
