import { describe, expect, it } from 'vitest'
import * as shared from '../src/index'

describe('@kadai/shared index', () => {
  it('re-exports the domain modules', () => {
    for (const name of [
      'newId',
      'roundDiv',
      'allocateProRata',
      'parseRupees',
      'formatINR',
      'roundToRupee',
      'UNITS',
      'amountForQty',
      'GST_RATES_BP',
      'isValidGstin',
      'computeLine',
      'computeDocument',
      'resolveSlabRate',
      'applyPromotions',
      'amountInWords',
      'fyOf',
      'normalizeIndianPhone',
      'buildUpiUri',
      'parseScaleBarcode',
      'PERMISSIONS',
      'ROLE_PRESETS',
      'FEATURES',
      'BusinessTypeSchema',
      'DEFAULT_CHART',
      'TenantSettingsSchema',
      'BUSINESS_TYPES',
      'VERTICAL_PRESETS',
      'ERROR_CODES',
    ]) {
      expect(shared, name).toHaveProperty(name)
    }
  })
  it('does not re-export API contracts', () => {
    expect(shared).not.toHaveProperty('SignupRequestSchema')
    expect(shared).not.toHaveProperty('dataOf')
  })
})
