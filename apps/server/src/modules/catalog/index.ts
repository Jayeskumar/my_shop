/**
 * catalog module — categories, brands, tax slab rules, products (vertical attributes, variants,
 * barcodes, scan lookup, bulk update, CSV import / export), promotions, store prices, barcode
 * labels, units and the HSN directory. Owned by the catalog module (ARCHITECTURE.md §3.1).
 *
 * Every endpoint of docs/API.md "catalog" is registered from the shared route catalogue
 * (`catalogRoutes` in @kadai/shared/api/catalog): method, path, schemas, permission and feature
 * guards come from the contract; `tx` implementations run in one tenant transaction (creates
 * marked `idempotent` replay through Idempotency-Key). Background jobs are in ./jobs.ts.
 */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { type RouteImpls, routePlugins } from '../../core/http'
import { defineModule } from '../module'
import { addBarcode, deleteBarcode } from './barcodes'
import { createBrand, deleteBrand, listBrands, updateBrand } from './brands'
import {
  createCategory,
  deleteCategory,
  getCategory,
  listCategories,
  updateCategory,
} from './categories'
import { searchHsn, unitsFor } from './directory'
import { sendImportTemplate, streamProductExport } from './export'
import { getImport, startProductImport } from './imports'
import { printLabels } from './labels'
import { lookupProduct } from './lookup'
import { getProductDetail, listProducts } from './product-read'
import { bulkUpdateProducts, createProduct, deleteProduct, updateProduct } from './product-write'
import {
  createPromotion,
  deletePromotion,
  getPromotion,
  listPromotions,
  updatePromotion,
} from './promotions'
import { tenantInfo } from './shared'
import { listStorePrices, updateStorePrices } from './store-prices'
import {
  createTaxSlabRule,
  deleteTaxSlabRule,
  getTaxSlabRule,
  listTaxSlabRules,
  updateTaxSlabRule,
} from './tax-slab-rules'
import { generateVariants } from './variants'

export const catalogImpls: RouteImpls<typeof catalogRoutes> = {
  // ---- categories
  listCategories: {
    tx: async (tx, req) => ({ data: await listCategories(tx, req.ctx, req.query) }),
  },
  createCategory: {
    tx: async (tx, req) => ({ data: await createCategory(tx, req.ctx, req.body) }),
  },
  getCategory: { tx: async (tx, req) => ({ data: await getCategory(tx, req.ctx, req.params.id) }) },
  updateCategory: {
    tx: async (tx, req) => ({ data: await updateCategory(tx, req.ctx, req.params.id, req.body) }),
  },
  deleteCategory: { tx: (tx, req) => deleteCategory(tx, req.ctx, req.params.id) },

  // ---- brands
  listBrands: { tx: (tx, req) => listBrands(tx, req.ctx, req.query) },
  createBrand: { tx: async (tx, req) => ({ data: await createBrand(tx, req.ctx, req.body) }) },
  updateBrand: {
    tx: async (tx, req) => ({ data: await updateBrand(tx, req.ctx, req.params.id, req.body) }),
  },
  deleteBrand: { tx: (tx, req) => deleteBrand(tx, req.ctx, req.params.id) },

  // ---- tax slab rules
  listTaxSlabRules: { tx: (tx, req) => listTaxSlabRules(tx, req.ctx, req.query) },
  createTaxSlabRule: {
    tx: async (tx, req) => ({ data: await createTaxSlabRule(tx, req.ctx, req.body) }),
  },
  getTaxSlabRule: {
    tx: async (tx, req) => ({ data: await getTaxSlabRule(tx, req.ctx, req.params.id) }),
  },
  updateTaxSlabRule: {
    tx: async (tx, req) => ({
      data: await updateTaxSlabRule(tx, req.ctx, req.params.id, req.body),
    }),
  },
  deleteTaxSlabRule: { tx: (tx, req) => deleteTaxSlabRule(tx, req.ctx, req.params.id) },

  // ---- products
  listProducts: { tx: (tx, req) => listProducts(tx, req.ctx, req.query) },
  lookupProduct: { tx: async (tx, req) => ({ data: await lookupProduct(tx, req.ctx, req.query) }) },
  exportProducts: {
    handler: (req, reply) => streamProductExport(req.server.kadai, req.ctx, reply, req.query),
  },
  productImportTemplate: {
    handler: async (req, reply) => {
      const bt =
        req.query.business_type ?? (await req.tx((tx) => tenantInfo(tx, req.ctx))).business_type
      return sendImportTemplate(reply, bt)
    },
  },
  importProducts: {
    tx: async (tx, req) => ({
      data: await startProductImport(tx, req.ctx, req.server.kadai.files, req.body),
    }),
  },
  bulkUpdateProducts: {
    tx: async (tx, req) => ({ data: await bulkUpdateProducts(tx, req.ctx, req.body) }),
  },
  createProduct: { tx: async (tx, req) => ({ data: await createProduct(tx, req.ctx, req.body) }) },
  getProduct: {
    tx: async (tx, req) => ({
      data: await getProductDetail(tx, req.ctx, req.params.id, req.query.store_id),
    }),
  },
  updateProduct: {
    tx: async (tx, req) => ({ data: await updateProduct(tx, req.ctx, req.params.id, req.body) }),
  },
  deleteProduct: {
    tx: async (tx, req) => ({ data: await deleteProduct(tx, req.ctx, req.params.id) }),
  },
  generateVariants: {
    tx: async (tx, req) => ({
      data: await generateVariants(tx, req.ctx, req.params.id, req.body),
    }),
  },
  addBarcode: {
    tx: async (tx, req) => ({ data: await addBarcode(tx, req.ctx, req.params.id, req.body) }),
  },
  deleteBarcode: {
    tx: (tx, req) => deleteBarcode(tx, req.ctx, req.params.id, req.params.barcodeId),
  },

  // ---- imports
  getImport: { tx: async (tx, req) => ({ data: await getImport(tx, req.ctx, req.params.id) }) },

  // ---- promotions
  listPromotions: { tx: (tx, req) => listPromotions(tx, req.ctx, req.query) },
  createPromotion: {
    tx: async (tx, req) => ({ data: await createPromotion(tx, req.ctx, req.body) }),
  },
  getPromotion: {
    tx: async (tx, req) => ({ data: await getPromotion(tx, req.ctx, req.params.id) }),
  },
  updatePromotion: {
    tx: async (tx, req) => ({
      data: await updatePromotion(tx, req.ctx, req.params.id, req.body),
    }),
  },
  deletePromotion: {
    tx: async (tx, req) => ({ data: await deletePromotion(tx, req.ctx, req.params.id) }),
  },

  // ---- store prices
  listStorePrices: { tx: (tx, req) => listStorePrices(tx, req.ctx, req.query) },
  updateStorePrices: {
    tx: async (tx, req) => ({ data: await updateStorePrices(tx, req.ctx, req.body) }),
  },

  // ---- labels, units, HSN
  printLabels: { tx: async (tx, req) => ({ data: await printLabels(tx, req.ctx, req.body) }) },
  listUnits: {
    tx: async (tx, req) => ({ data: unitsFor((await tenantInfo(tx, req.ctx)).business_type) }),
  },
  searchHsn: async (req) => ({ data: searchHsn(req.query.q, req.query.limit) }),
}

export const catalogModule = defineModule({
  name: 'catalog',
  ...routePlugins(catalogRoutes, catalogImpls),
})
