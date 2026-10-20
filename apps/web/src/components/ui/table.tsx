import {
  forwardRef,
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'

export const Table = forwardRef<
  HTMLTableElement,
  HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string }
>(function Table({ className, wrapperClassName, ...props }, ref) {
  return (
    <div className={cn('relative w-full overflow-x-auto scrollbar-thin', wrapperClassName)}>
      <table
        ref={ref}
        className={cn('w-full caption-bottom border-collapse text-sm', className)}
        {...props}
      />
    </div>
  )
})

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('bg-surface-2/70 [&_tr]:border-b', className)} {...props} />
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

export function TableFooter({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tfoot className={cn('border-t bg-surface-2/70 font-semibold', className)} {...props} />
}

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={cn(
          'border-b border-border transition-colors data-[state=selected]:bg-primary-soft/50',
          className,
        )}
        {...props}
      />
    )
  },
)

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'h-10 whitespace-nowrap px-3 text-start align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2.5 align-middle', className)} {...props} />
}

export function TableCaption({ className, ...props }: HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('mt-3 text-sm text-muted-foreground', className)} {...props} />
}
