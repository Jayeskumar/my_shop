/**
 * Form controls bound to tenant-settings paths (`invoice.show_hsn`, `pos.sound` …) for the
 * settings screens: a switch row, a number with unit, and a radio group. Paths are typed against
 * TenantSettings, so a typo is a type error.
 */
import type { ReactNode } from 'react'
import { Controller, type Path } from 'react-hook-form'
import type { TenantSettings } from '@kadai/shared/settings'
import { NumberInput, RadioGroup, Switch, type RadioOption } from '@/components/ui'
import { cn } from '@/lib/cn'
import { SettingsField } from './SettingsField'

type SettingsPath = Path<TenantSettings>

export function SwitchField({
  name,
  label,
  description,
  disabled,
  className,
}: {
  name: SettingsPath
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <Controller<TenantSettings, SettingsPath>
      name={name}
      render={({ field }) => (
        <div className={cn('rounded-lg border border-border px-3 py-3', className)}>
          <Switch
            checked={field.value === true}
            onCheckedChange={field.onChange}
            onBlur={field.onBlur}
            label={label}
            description={description}
            disabled={disabled}
          />
        </div>
      )}
    />
  )
}

/** A number box followed by its unit word ("90 நாட்கள்"). */
export function WithUnit({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <span className="shrink-0 text-sm text-muted-foreground">{unit}</span>
    </div>
  )
}

export function NumberField({
  name,
  label,
  hint,
  suffix,
  unit,
  prefix,
  min,
  max,
  decimals,
  scale,
  disabled,
  className,
  inputClassName,
}: {
  name: SettingsPath
  label: ReactNode
  hint?: ReactNode
  /** Short symbol inside the box (%). */
  suffix?: ReactNode
  /** A word unit (days, points) shown after the box — Tamil words do not fit inside it. */
  unit?: string
  prefix?: ReactNode
  min?: number
  max?: number
  decimals?: number
  scale?: 1 | 10 | 100 | 1000 | 10000
  disabled?: boolean
  className?: string
  inputClassName?: string
}) {
  return (
    <SettingsField name={name} label={label} hint={hint} className={className}>
      <Controller<TenantSettings, SettingsPath>
        name={name}
        render={({ field }) => {
          const input = (
            <NumberInput
              value={typeof field.value === 'number' ? field.value : null}
              onChange={(v) => field.onChange(v ?? 0)}
              onBlur={field.onBlur}
              min={min}
              max={max}
              decimals={decimals}
              scale={scale}
              suffix={suffix}
              prefix={prefix}
              disabled={disabled}
              className={cn('tabular-nums', inputClassName)}
            />
          )
          return unit ? <WithUnit unit={unit}>{input}</WithUnit> : input
        }}
      />
    </SettingsField>
  )
}

export function RadioField<V extends string>({
  name,
  label,
  hint,
  options,
  variant = 'cards',
  orientation,
  disabled,
}: {
  name: SettingsPath
  label: ReactNode
  hint?: ReactNode
  options: readonly RadioOption<V>[]
  variant?: 'list' | 'cards'
  orientation?: 'vertical' | 'horizontal'
  disabled?: boolean
}) {
  return (
    <SettingsField name={name} label={label} hint={hint}>
      <Controller<TenantSettings, SettingsPath>
        name={name}
        render={({ field }) => (
          <RadioGroup<V>
            value={field.value as V}
            onValueChange={field.onChange}
            options={options}
            variant={variant}
            orientation={orientation}
            disabled={disabled}
          />
        )}
      />
    </SettingsField>
  )
}
