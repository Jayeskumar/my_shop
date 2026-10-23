/**
 * Customer form values ⇄ request bodies. Create sends the full CustomerCreate body; edit sends a
 * PATCH with only the fields that differ from the loaded record plus `if_updated_at`.
 */
import type { Customer, CustomerCreate, CustomerUpdate } from '@kadai/shared/api/parties'
import { CustomerTypeSchema, type CustomerType, type PriceTier } from '@kadai/shared/enums'
import { formatPhone } from '@/lib/format'
import {
  type AddressFormValues,
  addressFromRecord,
  addressToBody,
  EMPTY_ADDRESS,
  signedOpening,
  textOrNull,
} from './forms'

export const CUSTOMER_TYPES: readonly CustomerType[] = CustomerTypeSchema.options

export interface CustomerFormValues {
  name: string
  name_ta: string
  phone: string
  alt_phone: string
  email: string
  code: string
  gstin: string
  state_code: string | null
  customer_type: CustomerType
  /** 'auto' = the contract default (wholesale customers get wholesale prices). */
  price_tier: PriceTier | 'auto'
  credit_limit_paise: number | null
  credit_days: number | null
  opening_side: 'due' | 'advance'
  opening_amount_paise: number | null
  date_of_birth: string | null
  anniversary: string | null
  notes: string
  tags: string[]
  whatsapp_opt_in: boolean
  address: AddressFormValues
}

/** Prefill from what the cashier typed in a picker ("Add customer …"). */
export interface CustomerDraftInput {
  name?: string
  /** E.164 or a typed 10-digit number. */
  phone?: string
}

export function emptyCustomerValues(
  draft: CustomerDraftInput = {},
  stateCode: string | null = null,
): CustomerFormValues {
  return {
    name: draft.name ?? '',
    name_ta: '',
    phone: draft.phone ? formatPhone(draft.phone) || draft.phone : '',
    alt_phone: '',
    email: '',
    code: '',
    gstin: '',
    state_code: stateCode,
    customer_type: 'retail',
    price_tier: 'auto',
    credit_limit_paise: null,
    credit_days: null,
    opening_side: 'due',
    opening_amount_paise: null,
    date_of_birth: null,
    anniversary: null,
    notes: '',
    tags: [],
    whatsapp_opt_in: true,
    address: { ...EMPTY_ADDRESS },
  }
}

export function customerToValues(c: Customer): CustomerFormValues {
  return {
    name: c.name,
    name_ta: c.name_ta ?? '',
    phone: c.phone ? formatPhone(c.phone) : '',
    alt_phone: c.alt_phone ?? '',
    email: c.email ?? '',
    code: c.code ?? '',
    gstin: c.gstin ?? '',
    state_code: c.state_code ?? c.address.state_code ?? null,
    customer_type: c.customer_type,
    price_tier: c.price_tier,
    credit_limit_paise: c.credit_limit_paise,
    credit_days: c.credit_days,
    opening_side: c.opening_balance_paise < 0 ? 'advance' : 'due',
    opening_amount_paise: c.opening_balance_paise === 0 ? null : Math.abs(c.opening_balance_paise),
    date_of_birth: c.date_of_birth,
    anniversary: c.anniversary,
    notes: c.notes ?? '',
    tags: [...c.tags],
    whatsapp_opt_in: c.whatsapp_opt_in,
    address: addressFromRecord(c.address),
  }
}

/** POST /customers body for the form values. */
export function customerCreateBody(v: CustomerFormValues): CustomerCreate {
  return {
    name: v.name,
    name_ta: textOrNull(v.name_ta),
    code: textOrNull(v.code),
    phone: textOrNull(v.phone),
    alt_phone: textOrNull(v.alt_phone),
    email: textOrNull(v.email),
    gstin: textOrNull(v.gstin),
    state_code: v.state_code,
    address: addressToBody(v.address, v.state_code),
    customer_type: v.customer_type,
    ...(v.price_tier === 'auto' ? {} : { price_tier: v.price_tier }),
    credit_limit_paise: v.credit_limit_paise,
    credit_days: v.credit_days,
    opening_balance_paise: signedOpening(v.opening_side, v.opening_amount_paise),
    date_of_birth: v.date_of_birth,
    anniversary: v.anniversary,
    notes: textOrNull(v.notes),
    tags: v.tags,
    whatsapp_opt_in: v.whatsapp_opt_in,
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** PATCH /customers/:id body: only what changed since `initial`, with if_updated_at. */
export function customerPatchBody(
  v: CustomerFormValues,
  initial: CustomerFormValues,
  updatedAt: string,
): CustomerUpdate {
  const body = customerCreateBody(v)
  const before = customerCreateBody(initial)
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(body) as (keyof CustomerCreate)[]) {
    if (key === 'price_tier') continue
    if (!same(body[key], before[key])) patch[key] = body[key]
  }
  if (v.price_tier !== initial.price_tier && v.price_tier !== 'auto')
    patch.price_tier = v.price_tier
  // The state is kept in the column and in the address; keep both in step.
  if ('state_code' in patch) patch.address = body.address
  return { ...(patch as CustomerUpdate), if_updated_at: updatedAt }
}

/** Body path of a contract / server issue → form field path (null = not shown). */
export function customerFieldOf(bodyPath: string): string | null {
  if (bodyPath === 'opening_balance_paise') return 'opening_amount_paise'
  if (bodyPath === 'address.state_code') return 'state_code'
  if (bodyPath === 'if_updated_at') return null
  return bodyPath
}
