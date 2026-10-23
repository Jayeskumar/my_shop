/**
 * Form state for the tenant-settings screens (invoice, POS & stock, pharmacy, loyalty & credit):
 * loads GET /settings, edits the chosen sections with the shared section schemas as validation,
 * and saves only what changed through PATCH /settings (a strict deep-partial; arrays replace).
 * Business-wide: store-scoped members get the form read-only.
 */
import { useEffect, useRef } from 'react'
import { useForm, type DefaultValues, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { SettingsPatch } from '@kadai/shared/api/identity'
import {
  DEFAULT_SETTINGS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type TenantSettings,
} from '@kadai/shared/settings'
import { notify } from '@/components/ui'
import { applyServerFieldErrors } from '@/lib/form-errors'
import { useSettings, useUpdateSettings } from '../api'
import { useBusinessWideEdit } from './access'
import { changedFields, contractResolver } from './forms'
import { notifySettingsError } from './messages'

export type SectionValues<K extends SettingsSection> = Pick<TenantSettings, K>

/** Fixed English messages of shared refinements → settings:validation keys. */
const MESSAGE_KEYS: Readonly<Record<string, string>> = {
  'prefix + item code + value + check digit must be 13 digits': 'scale_length',
}

function pick<K extends SettingsSection>(settings: TenantSettings, keys: readonly K[]) {
  return Object.fromEntries(keys.map((k) => [k, settings[k]])) as SectionValues<K>
}

export interface SettingsFormApi<K extends SettingsSection> {
  form: UseFormReturn<SectionValues<K>>
  loaded: boolean
  error: unknown
  refetch: () => void
  canEdit: boolean
  storeScoped: boolean
  dirty: boolean
  saving: boolean
  save: () => void
  discard: () => void
}

export function useSettingsForm<K extends SettingsSection>(
  keys: readonly K[],
  savedMessage?: string,
): SettingsFormApi<K> {
  const { t } = useTranslation('settings')
  const query = useSettings()
  const settings = query.data?.data.settings
  const { canEdit, storeScoped } = useBusinessWideEdit()
  const update = useUpdateSettings()
  const schema = z.object(Object.fromEntries(keys.map((k) => [k, SETTINGS_SECTIONS[k]])))
  const form = useForm<SectionValues<K>>({
    defaultValues: pick(DEFAULT_SETTINGS, keys) as DefaultValues<SectionValues<K>>,
    resolver: contractResolver<SectionValues<K>>(
      schema,
      (v) => v,
      (p) => p,
      (m) => MESSAGE_KEYS[m] ?? m,
    ),
    mode: 'onChange',
  })
  const initial = useRef<SectionValues<K> | null>(null)
  const loadedJson = useRef<string | null>(null)

  useEffect(() => {
    if (!settings) return
    const values = pick(settings, keys)
    const json = JSON.stringify(values)
    if (json === loadedJson.current) return
    if (loadedJson.current !== null && form.formState.isDirty) return
    loadedJson.current = json
    initial.current = values
    form.reset(values)
    // `keys` is a constant per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, form])

  const save = form.handleSubmit(async (values) => {
    const base = initial.current
    if (!base) return
    const patch = changedFields(base, values)
    if (!patch) {
      form.reset(values)
      return
    }
    try {
      const res = await update.mutateAsync({ body: patch as SettingsPatch })
      const next = pick(res.data.settings, keys)
      initial.current = next
      loadedJson.current = JSON.stringify(next)
      form.reset(next)
      notify.success(savedMessage ?? t('common.saved'))
    } catch (error) {
      if (!applyServerFieldErrors(error, form.setError, keys)) notifySettingsError(error)
    }
  })

  return {
    form,
    loaded: Boolean(settings),
    error: query.error,
    refetch: () => void query.refetch(),
    canEdit,
    storeScoped,
    dirty: form.formState.isDirty,
    saving: update.isPending,
    save: () => void save(),
    discard: () => {
      if (initial.current) form.reset(initial.current)
    },
  }
}
