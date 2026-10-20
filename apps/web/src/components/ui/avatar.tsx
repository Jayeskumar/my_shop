import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/cn'

const avatarVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold',
  {
    variants: {
      size: { sm: 'size-7 text-xs', md: 'size-9 text-sm', lg: 'size-12 text-base', xl: 'size-16 text-xl' },
    },
    defaultVariants: { size: 'md' },
  },
)

// Stable, pleasant background per name (teal/saffron/blue/rose/violet/emerald families).
const TONES = [
  'bg-primary-100 text-primary-800 dark:bg-primary-900 dark:text-primary-100',
  'bg-accent-100 text-accent-800 dark:bg-accent-900 dark:text-accent-100',
  'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
  'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-100',
  'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-100',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-100',
]

function toneFor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return TONES[hash % TONES.length] ?? TONES[0]!
}

let segmenter: Intl.Segmenter | undefined

/**
 * Up to two initials, grapheme-aware so Tamil names keep their vowel signs:
 * "Murugan K" → "MK", "முருகன் கண்ணன்" → "முக".
 */
export function initialsOf(name: string): string {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const words = name.trim().split(/\s+/u).filter(Boolean)
  const first = (w: string): string => {
    const it = segmenter!.segment(w)[Symbol.iterator]().next()
    return it.done ? '' : it.value.segment
  }
  const picks = words.length > 1 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1)
  return picks.map(first).join('').toLocaleUpperCase('en-IN')
}

export interface AvatarProps extends VariantProps<typeof avatarVariants> {
  name: string
  src?: string | null
  className?: string
}

export function Avatar({ name, src, size, className }: AvatarProps) {
  return (
    <AvatarPrimitive.Root className={cn(avatarVariants({ size }), toneFor(name), className)} title={name}>
      {src ? <AvatarPrimitive.Image src={src} alt={name} className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback delayMs={src ? 300 : 0} className="flex size-full items-center justify-center">
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  )
}
