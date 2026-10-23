/**
 * Supplier form values ⇄ request bodies. Bank account numbers are write-only: the server keeps
 * only the last 4 digits, so the field starts empty and is sent only when typed (or cleared on
 * purpose with `clear_account_no`).
 */
import type { Supplier, SupplierCreate, SupplierUpdate } from '@kadai/shared/api/parties'
import { formatPhone } from '@/lib/format'
import {
  type AddressFormValues,
  addressFromRecord,
  addressToBody,
  EMPTY_ADDRESS,
  signedOpening,
  textOrNull,
} from './forms'

export interface BankFormValues {
  account_name: string
  account_number: string
  ifsc: string
  bank_name: string
}

export interface SupplierFormValues {
  name: string
  code: string
  contact_person: string
  phone: string
  email: string
  gstin: string
  pan: string
  state_code: string | null
  address: AddressFormValues
  drug_license_no: string
  payment_terms_days: number | null
  lead_time_days?: number | null
  opening_side: 'due' | 'advance'
  opening_amount_paise: number | null
  bank: BankFormValues
  clear_account_no: boolean
  upi_vpa: string
  notes: string
}

const EMPTY_BANK: BankFormValues = { account_name: '', account_number: '', ifsc: '', bank_name: '' }

export function emptySupplierValues(stateCode: string | null): SupplierFormValues {
  return {
    name: '',
    code: '',
    contact_person: '',
    phone: '',
    email: '',
    gstin: '',
    pan: '',
    state_code: stateCode,
    address: { ...EMPTY_ADDRESS },
    drug_license_no: '',
    payment_terms_days: null,
    lead_time_days: null,
    opening_side: 'due',
    opening_amount_paise: null,
    bank: { ...EMPTY_BANK },
    clear_account_no: false,
    upi_vpa: '',
    notes: '',
  }
}

export function supplierToValues(s: Supplier): SupplierFormValues {
  return {
    name: s.name,
    code: s.code ?? '',
    contact_person: s.contact_person ?? '',
    phone: s.phone ? formatPhone(s.phone) : '',
    email: s.email ?? '',
    gstin: s.gstin ?? '',
    pan: s.pan ?? '',
    state_code: s.state_code ?? s.address.state_code ?? null,
    address: addressFromRecord(s.address),
    drug_license_no: s.drug_license_no ?? '',
    payment_terms_days: s.payment_terms_days,
    lead_time_days: s.lead_time_days ?? null,
    opening_side: s.opening_balance_paise < 0 ? 'advance' : 'due',
    opening_amount_paise: s.opening_balance_paise === 0 ? null : Math.abs(s.opening_balance_paise),
    bank: {
      account_name: s.bank_details.account_name ?? '',
      account_number: '',
      ifsc: s.bank_details.ifsc ?? '',
      bank_name: s.bank_details.bank_name ?? '',
    },
    clear_account_no: false,
    upi_vpa: s.upi_vpa ?? '',
    notes: s.notes ?? '',
  }
}

function bankBody(v: SupplierFormValues): SupplierCreate['bank_details'] {
  const number = v.bank.account_number.replace(/\s/g, '')
  return {
    account_name: textOrNull(v.bank.account_name),
    ifsc: textOrNull(v.bank.ifsc.toUpperCase()),
    bank_name: textOrNull(v.bank.bank_name),
    ...(number ? { account_number: number } : v.clear_account_no ? { account_number: null } : {}),
  }
}

/** POST /suppliers body. Bank details are sent only when something was entered. */
export function supplierCreateBody(v: SupplierFormValues): SupplierCreate {
  const bank = bankBody(v)
  const anyBank = Object.values(bank ?? {}).some((x) => x !== null && x !== undefined)
  return {
    name: v.name,
    code: textOrNull(v.code),
    contact_person: textOrNull(v.contact_person),
    phone: textOrNull(v.phone),
    email: textOrNull(v.email),
    gstin: textOrNull(v.gstin),
    pan: textOrNull(v.pan),
    state_code: v.state_code,
    address: addressToBody(v.address, v.state_code),
    drug_license_no: textOrNull(v.drug_license_no),
    payment_terms_days: v.payment_terms_days,
    ...(v.lead_time_days !== undefined && v.lead_time_days !== null
      ? { lead_time_days: v.lead_time_days }
      : {}),
    opening_balance_paise: signedOpening(v.opening_side, v.opening_amount_paise),
    ...(anyBank ? { bank_details: bank } : {}),
    upi_vpa: textOrNull(v.upi_vpa),
    notes: textOrNull(v.notes),
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** PATCH /suppliers/:id body with only the changed fields and if_updated_at. */
export function supplierPatchBody(
  v: SupplierFormValues,
  initial: SupplierFormValues,
  updatedAt: string,
): SupplierUpdate {
  const body = supplierCreateBody(v)
  const before = supplierCreateBody(initial)
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(body) as (keyof SupplierCreate)[]) {
    if (key === 'bank_details') continue
    if (!same(body[key], before[key])) patch[key] = body[key]
  }
  if ((v.lead_time_days ?? null) !== (initial.lead_time_days ?? null)) {
    patch.lead_time_days = v.lead_time_days ?? null
  }
  const bank = bankBody(v)
  if (!same(bank, bankBody(initial))) patch.bank_details = bank
  if ('state_code' in patch) patch.address = body.address
  return { ...(patch as SupplierUpdate), if_updated_at: updatedAt }
}

export function supplierFieldOf(bodyPath: string): string | null {
  if (bodyPath === 'opening_balance_paise') return 'opening_amount_paise'
  if (bodyPath === 'address.state_code') return 'state_code'
  if (bodyPath.startsWith('bank_details.')) return `bank.${bodyPath.slice('bank_details.'.length)}`
  if (bodyPath === 'bank_details') return 'bank.account_number'
  if (bodyPath === 'if_updated_at') return null
  return bodyPath
}
