/**
 * Step-level checks for the onboarding wizards.
 *
 * The shared Signup/SetupRequestSchema validates GSTIN ↔ state ↔ GST scheme in a superRefine
 * that only runs once every field is valid, i.e. on the final step. To give feedback on the
 * business step itself, the same three rules are mirrored here (keep in sync with
 * `refineBusiness` in packages/shared/src/api/auth.ts — the shared schema stays authoritative
 * and still runs on submit).
 */
import type { BusinessType, GstScheme } from '@kadai/shared/enums'
import type { ValidationKey } from '@/lib/validation'

export interface BusinessFormValues {
  business_type: BusinessType
  business_name: string
  business_name_ta?: string
  state_code: string
  gstin?: string | null
  gst_scheme?: GstScheme
  owner_name: string
  phone: string
  password: string
  email?: string
  locale?: 'ta' | 'en'
  // signup
  otp_token?: string
  // on-prem setup
  legal_name?: string
  store_name?: string
  setup_token?: string
}

export type WizardStep = 'business_type' | 'business' | 'owner'

export const STEP_FIELDS: Record<WizardStep, readonly (keyof BusinessFormValues)[]> = {
  business_type: ['business_type'],
  business: [
    'business_name',
    'business_name_ta',
    'state_code',
    'gstin',
    'gst_scheme',
    'legal_name',
    'store_name',
  ],
  owner: ['owner_name', 'phone', 'password', 'email', 'setup_token'],
}

export function stepOfField(field: string): WizardStep | null {
  const root = field.split('.')[0] ?? ''
  for (const step of Object.keys(STEP_FIELDS) as WizardStep[]) {
    if ((STEP_FIELDS[step] as readonly string[]).includes(root)) return step
  }
  return null
}

/** Mirror of shared `refineBusiness` (see header). */
export function businessGstIssues(
  values: Pick<BusinessFormValues, 'gstin' | 'gst_scheme' | 'state_code'>,
): {
  field: 'gstin' | 'gst_scheme'
  key: ValidationKey
}[] {
  const gstin = (values.gstin ?? '').trim().toUpperCase()
  const issues: { field: 'gstin' | 'gst_scheme'; key: ValidationKey }[] = []
  if (gstin && gstin.slice(0, 2) !== values.state_code)
    issues.push({ field: 'gstin', key: 'gstin_state' })
  if (values.gst_scheme === 'unregistered' && gstin)
    issues.push({ field: 'gst_scheme', key: 'gstin_unregistered' })
  if ((values.gst_scheme === 'regular' || values.gst_scheme === 'composition') && !gstin)
    issues.push({ field: 'gstin', key: 'gstin_required' })
  return issues
}
