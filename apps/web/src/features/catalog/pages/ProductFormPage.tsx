/**
 * /catalog/products/new and /catalog/products/:id — loads the product (GET /products/:id with the
 * current store for stock) and renders the sectioned product form; actions: print label,
 * duplicate, activate / deactivate and delete (a used product is deactivated by the server).
 */
import { PRODUCT_KIND_LABELS, catalogRoutes } from '@kadai/shared/api/catalog'
import { Barcode, Copy, EyeOff, Eye, MoreVertical, PackageX, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  PageHeader,
  Skeleton,
  notify,
  useConfirm,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan, useCurrentStore, useFeature, useMe } from '@/lib/auth'
import { localizedName } from '@/lib/i18n'
import { useRouteMutation, useRouteQuery } from '@/lib/query'
import { LinkButton } from '../components/LinkButton'
import { bilingual } from '../lib/format'
import {
  type ProductFormValues,
  defaultProductValues,
  valuesFromProduct,
} from '../lib/product-form'
import { ProductForm } from '../product-form/ProductForm'

interface CopyState {
  copy?: ProductFormValues
}

export default function ProductFormPage() {
  const { id } = useParams()
  return id ? <EditProduct id={id} /> : <NewProduct />
}

function NewProduct() {
  const { t } = useTranslation(['catalog', 'common'])
  const me = useMe()
  const store = useCurrentStore()
  const location = useLocation()
  const [params] = useSearchParams()
  const copy = (location.state as CopyState | null)?.copy
  const barcode = params.get('barcode')?.trim()
  const defaults = useMemo(() => {
    const base = me
      ? defaultProductValues({ settings: me.settings, businessType: me.tenant.business_type })
      : null
    if (!base) return null
    if (copy) return { ...copy, kind: copy.kind === 'variant' ? ('standard' as const) : copy.kind }
    return barcode ? { ...base, barcodes: [{ barcode, qty_milli: 1000 }] } : base
  }, [me, copy, barcode])
  if (!defaults) return null
  return (
    <div>
      <PageHeader
        title={copy ? t('form.copy_title', { name: copy.name }) : t('pages.product_new')}
        breadcrumbs={[
          { label: t('pages.products'), to: '/catalog/products' },
          { label: t('pages.product_new') },
        ]}
        description={t('form.new_hint')}
      />
      <ProductForm
        key={location.key}
        mode="create"
        product={null}
        defaults={defaults}
        storeId={store?.id ?? null}
      />
    </div>
  )
}

function EditProduct({ id }: { id: string }) {
  const { t } = useTranslation(['catalog', 'common'])
  const navigate = useNavigate()
  const store = useCurrentStore()
  const confirm = useConfirm()
  const canWrite = useCan('catalog.write')
  const hasLabels = useFeature('barcode_labels')
  const query = useRouteQuery(catalogRoutes.getProduct, {
    params: { id },
    query: store ? { store_id: store.id } : {},
  })
  const product = query.data?.data ?? null
  const del = useRouteMutation(catalogRoutes.deleteProduct, {
    invalidates: [catalogRoutes.listProducts, catalogRoutes.getProduct],
  })
  const setActive = useRouteMutation(catalogRoutes.updateProduct, {
    invalidates: [catalogRoutes.listProducts, catalogRoutes.getProduct],
  })

  if (query.isPending) {
    return (
      <div className="mx-auto grid grid-cols-1 max-w-5xl gap-4" aria-busy>
        <Skeleton className="h-8 w-64" />
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-48 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (!product) {
    const missing = isApiError(query.error) && query.error.status === 404
    return (
      <EmptyState
        icon={<PackageX />}
        title={missing ? t('form.not_found') : t('form.load_failed')}
        description={missing ? t('form.not_found_hint') : undefined}
        action={
          <LinkButton to="/catalog/products" variant="outline">
            {t('form.back_to_list')}
          </LinkButton>
        }
      />
    )
  }

  const name = localizedName(product.name, product.name_ta)

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('form.delete_title', { name }),
      description: t('form.delete_description'),
      tone: 'danger',
      confirmLabel: t('common:actions.delete'),
    })
    if (!ok) return
    del.mutate(
      { params: { id: product.id } },
      {
        onSuccess: (res) => {
          if (res.data.result === 'deleted') {
            notify.success(t('form.deleted', { name }))
            void navigate('/catalog/products', { replace: true })
          } else notify.info(t('form.deactivated_instead', { name }))
        },
      },
    )
  }

  const toggleActive = (): void =>
    setActive.mutate(
      {
        params: { id: product.id },
        body: { is_active: !product.is_active, if_updated_at: product.updated_at },
      },
      {
        onSuccess: () =>
          notify.success(
            product.is_active ? t('form.deactivated', { name }) : t('form.activated', { name }),
          ),
      },
    )

  return (
    <div>
      <PageHeader
        title={name}
        breadcrumbs={[{ label: t('pages.products'), to: '/catalog/products' }, { label: name }]}
        description={
          [product.sku, product.primary_barcode].filter(Boolean).join(' · ') || undefined
        }
        meta={
          <>
            {!product.is_active ? (
              <Badge tone="neutral" appearance="outline">
                {t('common:status.inactive')}
              </Badge>
            ) : null}
            {product.kind !== 'standard' ? (
              <Badge tone="info" className="hidden sm:inline-flex">
                {bilingual(PRODUCT_KIND_LABELS[product.kind])}
              </Badge>
            ) : null}
          </>
        }
        actions={
          <>
            {hasLabels && product.kind !== 'variant_parent' ? (
              <LinkButton
                to={`/catalog/labels?product_ids=${product.id}`}
                variant="outline"
                icon={<Barcode />}
                compact
              >
                {t('barcodes.print_label')}
              </LinkButton>
            ) : null}
            {canWrite ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    leftIcon={<MoreVertical />}
                    aria-label={t('common:actions.more')}
                  >
                    <span className="hidden sm:inline">{t('common:actions.more')}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {product.kind !== 'variant' ? (
                    <DropdownMenuItem
                      icon={<Copy />}
                      onSelect={() =>
                        void navigate('/catalog/products/new', {
                          state: {
                            copy: {
                              ...valuesFromProduct(product),
                              kind:
                                product.kind === 'variant_parent' ? 'variant_parent' : product.kind,
                              sku: '',
                              barcodes: [],
                            },
                          } satisfies CopyState,
                        })
                      }
                    >
                      {t('form.duplicate')}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    icon={product.is_active ? <EyeOff /> : <Eye />}
                    onSelect={toggleActive}
                  >
                    {product.is_active ? t('form.deactivate') : t('form.activate')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem icon={<Trash2 />} tone="danger" onSelect={() => void remove()}>
                    {t('common:actions.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      />
      {product.parent ? (
        <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info-soft-foreground">
          {t('form.variant_of')}{' '}
          <Link to={`/catalog/products/${product.parent.id}`} className="font-semibold underline">
            {localizedName(product.parent.name, product.parent.name_ta)}
          </Link>
          <span className="opacity-80">
            ({Object.values(product.variant_attributes).join(' / ')})
          </span>
        </div>
      ) : null}
      {!canWrite ? (
        <p className="mx-auto mb-4 max-w-5xl rounded-lg bg-surface-2 px-4 py-2 text-sm text-muted-foreground">
          {t('form.read_only')}
        </p>
      ) : null}
      <ProductForm
        key={product.id}
        mode="edit"
        product={product}
        defaults={valuesFromProduct(product)}
        storeId={store?.id ?? null}
      />
    </div>
  )
}
