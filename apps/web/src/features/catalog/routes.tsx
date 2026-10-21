/**
 * Routes of the catalog feature — Products, categories, brands, offers, tax rules, labels, import
 * and branch prices. Paths and handles are the contract (nav, guards, links from other modules).
 */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  app: [
    {
      path: 'catalog/products',
      handle: { title: 'nav:titles.products', permission: 'catalog.read' },
      lazy: page(() => import('./pages/ProductsPage')),
    },
    {
      path: 'catalog/products/new',
      handle: {
        title: 'nav:titles.product_new',
        permission: 'catalog.write',
        parent: { title: 'nav:titles.products', to: '/catalog/products' },
      },
      lazy: page(() => import('./pages/ProductFormPage')),
    },
    {
      path: 'catalog/products/:id',
      handle: {
        title: 'nav:titles.product',
        permission: 'catalog.read',
        parent: { title: 'nav:titles.products', to: '/catalog/products' },
      },
      lazy: page(() => import('./pages/ProductFormPage')),
    },
    {
      path: 'catalog/categories',
      handle: { title: 'nav:titles.categories', permission: 'catalog.read' },
      lazy: page(() => import('./pages/CategoriesPage')),
    },
    {
      path: 'catalog/brands',
      handle: { title: 'nav:titles.brands', permission: 'catalog.read' },
      lazy: page(() => import('./pages/BrandsPage')),
    },
    {
      path: 'catalog/promotions',
      handle: { title: 'nav:titles.promotions', permission: 'catalog.read', feature: 'promotions' },
      lazy: page(() => import('./pages/PromotionsPage')),
    },
    {
      path: 'catalog/tax-rules',
      handle: { title: 'nav:titles.tax_rules', permission: 'catalog.read' },
      lazy: page(() => import('./pages/TaxRulesPage')),
    },
    {
      path: 'catalog/labels',
      handle: { title: 'nav:titles.labels', permission: 'catalog.read', feature: 'barcode_labels' },
      lazy: page(() => import('./pages/LabelsPage')),
    },
    {
      path: 'catalog/import',
      handle: {
        title: 'nav:titles.catalog_import',
        permission: 'catalog.write',
        parent: { title: 'nav:titles.products', to: '/catalog/products' },
      },
      lazy: page(() => import('./pages/ImportPage')),
    },
    {
      // Branch prices (feature store_pricing) — linked from the products list.
      path: 'catalog/store-prices',
      handle: {
        title: 'catalog:pages.store_prices',
        permission: 'catalog.write',
        feature: 'store_pricing',
        parent: { title: 'nav:titles.products', to: '/catalog/products' },
      },
      lazy: page(() => import('./pages/StorePricesPage')),
    },
  ],
}
