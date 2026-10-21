/** Square product photo (authenticated file blob) with a neutral placeholder. */
import { Package } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useFileObjectUrl } from '../lib/files'

export interface ProductThumbProps {
  fileId: string | null | undefined
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  /** Local preview (just picked file) shown instead of the stored file. */
  previewUrl?: string | null
}

const SIZES = {
  sm: 'size-9 rounded-md [&_svg]:size-4',
  md: 'size-11 rounded-lg [&_svg]:size-5',
  lg: 'size-20 rounded-xl [&_svg]:size-8',
  xl: 'size-32 rounded-xl [&_svg]:size-10',
}

export function ProductThumb({
  fileId,
  name,
  size = 'sm',
  className,
  previewUrl,
}: ProductThumbProps) {
  const stored = useFileObjectUrl(previewUrl ? null : fileId)
  const src = previewUrl ?? stored
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-2 text-muted-foreground',
        SIZES[size],
        className,
      )}
    >
      {src ? (
        <img src={src} alt={name} className="size-full object-cover" loading="lazy" />
      ) : (
        <Package aria-hidden />
      )}
    </span>
  )
}
