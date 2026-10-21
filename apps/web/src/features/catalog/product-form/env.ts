/** Context shared by the product form sections (mode, loaded product, read-only, tenant data). */
import type { ProductDetail } from '@kadai/shared/api/catalog'
import { createContext, useContext } from 'react'
import { useFormContext } from 'react-hook-form'
import type { ProductFormContext, ProductFormMode, ProductFormValues } from '../lib/product-form'

export interface ProductFormEnv extends ProductFormContext {
  mode: ProductFormMode
  product: ProductDetail | null
  readOnly: boolean
  storeId: string | null
  /** Variant matrix editor state of a new product (generated after the first save). */
  hasVariantsFeature: boolean
}

export const ProductFormEnvContext = createContext<ProductFormEnv | null>(null)

export function useProductFormEnv(): ProductFormEnv {
  const env = useContext(ProductFormEnvContext)
  if (!env) throw new Error('useProductFormEnv must be used inside the product form')
  return env
}

export function useProductForm() {
  return useFormContext<ProductFormValues>()
}
