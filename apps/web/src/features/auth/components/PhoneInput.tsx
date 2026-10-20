import { forwardRef } from 'react'
import { Input, type InputProps } from '@/components/ui'

/**
 * Indian mobile number input (+91 prefix shown). The raw text is validated / normalised to
 * E.164 by the shared `zPhone` schema, which accepts 10 digits with or without 0 / +91.
 */
export const PhoneInput = forwardRef<HTMLInputElement, Omit<InputProps, 'type' | 'startAdornment'>>(
  function PhoneInput(props, ref) {
    return (
      <Input
        ref={ref}
        type="tel"
        inputMode="tel"
        autoComplete="tel-national"
        maxLength={16}
        startAdornment={<span className="text-sm font-medium text-muted-foreground">+91</span>}
        className="tracking-wide tabular-nums"
        {...props}
      />
    )
  },
)
