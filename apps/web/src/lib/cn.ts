import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge must know the custom theme tokens, otherwise e.g. `text-muted-foreground`
// and `text-sm` would be treated as conflicting (both start with `text-`).
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        'background',
        'foreground',
        'surface',
        'surface-2',
        'surface-3',
        'muted-foreground',
        'border',
        'input',
        'ring',
        'overlay',
        'primary',
        'primary-hover',
        'primary-foreground',
        'primary-soft',
        'primary-soft-foreground',
        'accent',
        'accent-hover',
        'accent-foreground',
        'accent-soft',
        'accent-soft-foreground',
        'success',
        'success-foreground',
        'success-soft',
        'success-soft-foreground',
        'warning',
        'warning-foreground',
        'warning-soft',
        'warning-soft-foreground',
        'danger',
        'danger-hover',
        'danger-foreground',
        'danger-soft',
        'danger-soft-foreground',
        'info',
        'info-foreground',
        'info-soft',
        'info-soft-foreground',
        'sidebar',
        'sidebar-foreground',
        'sidebar-active',
        'sidebar-active-foreground',
      ],
      shadow: ['card', 'raised', 'overlay'],
    },
  },
})

/** Joins class names and resolves Tailwind conflicts (last one wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
