/**
 * Routes of the catalog feature — Products, categories, brands, offers, tax rules, labels and import.
 * Paths and handles are the contract (nav, guards, links from other modules); replace the
 * placeholder `Component` with real pages, e.g. `lazy: page(() => import('./pages/ListPage'))`.
 */
import ModulePlaceholder from '@/app/pages/ModulePlaceholder'
import type { FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'catalog/products',
      handle: { title: 'nav:titles.products', permission: 'catalog.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/products/new',
      handle: { title: 'nav:titles.product_new', permission: 'catalog.write', parent: { title: 'nav:titles.products', to: '/catalog/products' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/products/:id',
      handle: { title: 'nav:titles.product', permission: 'catalog.read', parent: { title: 'nav:titles.products', to: '/catalog/products' } },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/categories',
      handle: { title: 'nav:titles.categories', permission: 'catalog.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/brands',
      handle: { title: 'nav:titles.brands', permission: 'catalog.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/promotions',
      handle: { title: 'nav:titles.promotions', permission: 'catalog.read', feature: 'promotions' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/tax-rules',
      handle: { title: 'nav:titles.tax_rules', permission: 'catalog.read' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/labels',
      handle: { title: 'nav:titles.labels', permission: 'catalog.read', feature: 'barcode_labels' },
      Component: ModulePlaceholder,
    },
    {
      path: 'catalog/import',
      handle: { title: 'nav:titles.catalog_import', permission: 'catalog.write', parent: { title: 'nav:titles.products', to: '/catalog/products' } },
      Component: ModulePlaceholder,
    },
  ],
}
