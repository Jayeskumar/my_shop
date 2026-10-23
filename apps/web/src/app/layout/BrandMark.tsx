import { useId } from 'react'
import { cn } from '@/lib/cn'

/** The Kadai storefront mark (same artwork as public/favicon.svg) + optional wordmark. */
export function BrandMark({
  size = 'md',
  withName = true,
  inverted = false,
  className,
}: {
  size?: 'sm' | 'md' | 'lg'
  withName?: boolean
  inverted?: boolean
  className?: string
}) {
  // Unique ids: several marks can be on one page (sidebar + mobile drawer).
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const bg = `kadai-bg-${uid}`
  const clip = `kadai-awning-${uid}`
  const box = size === 'lg' ? 'size-14' : size === 'sm' ? 'size-8' : 'size-10'
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 512 512" className={cn(box, 'shrink-0 drop-shadow-sm')} aria-hidden>
        <defs>
          <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#14B8A6" />
            <stop offset="0.45" stopColor="#0F766E" />
            <stop offset="1" stopColor="#134E4A" />
          </linearGradient>
          <clipPath id={clip}>
            <path d="M104 150h304v70a26 26 0 0 1-52 0a26 26 0 0 1-50 0a26 26 0 0 1-50 0a26 26 0 0 1-50 0a26 26 0 0 1-50 0a26 26 0 0 1-52 0z" />
          </clipPath>
        </defs>
        <rect width="512" height="512" rx="116" fill={`url(#${bg})`} />
        <rect x="128" y="212" width="256" height="196" rx="18" fill="#F8FAFC" />
        <rect x="222" y="292" width="68" height="116" rx="10" fill="#0F766E" />
        <circle cx="276" cy="352" r="6" fill="#FBBF24" />
        <rect x="152" y="270" width="52" height="52" rx="8" fill="#99F6E4" />
        <rect x="308" y="270" width="52" height="52" rx="8" fill="#99F6E4" />
        <rect x="92" y="112" width="328" height="46" rx="14" fill="#FDE68A" />
        <g clipPath={`url(#${clip})`}>
          <rect x="104" y="150" width="304" height="100" fill="#F59E0B" />
          <rect x="154" y="150" width="50" height="100" fill="#FFFBEB" />
          <rect x="254" y="150" width="50" height="100" fill="#FFFBEB" />
          <rect x="354" y="150" width="54" height="100" fill="#FFFBEB" />
        </g>
      </svg>
      {withName ? (
        <span className="flex flex-col leading-none">
          <span
            className={cn(
              'font-bold tracking-tight',
              size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-base' : 'text-lg',
              inverted ? 'text-white' : 'text-foreground',
            )}
          >
            StockSense
          </span>
          <span
            lang="ta"
            className={cn(
              'font-tamil font-semibold',
              size === 'lg' ? 'text-base' : 'text-xs',
              inverted ? 'text-accent-200' : 'text-accent-700 dark:text-accent-400',
            )}
          >
            ஸ்டாக்சென்ஸ்
          </span>
        </span>
      ) : null}
    </span>
  )
}
