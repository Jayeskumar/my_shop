import * as TabsPrimitive from '@radix-ui/react-tabs'
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef, type ElementRef } from 'react'
import { cn } from '@/lib/cn'

type TabsVariant = 'underline' | 'pills'
const VariantContext = createContext<TabsVariant>('underline')

export interface TabsProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant
}

export const Tabs = forwardRef<ElementRef<typeof TabsPrimitive.Root>, TabsProps>(function Tabs(
  { variant = 'underline', className, ...props },
  ref,
) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.Root ref={ref} className={cn('flex flex-col gap-4', className)} {...props} />
    </VariantContext.Provider>
  )
})

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(function TabsList({ className, ...props }, ref) {
  const variant = useContext(VariantContext)
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'scrollbar-thin flex max-w-full items-center overflow-x-auto',
        variant === 'underline' ? 'gap-1 border-b border-border' : 'w-fit gap-1 rounded-lg bg-surface-2 p-1',
        className,
      )}
      {...props}
    />
  )
})

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  const variant = useContext(VariantContext)
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
        variant === 'underline'
          ? '-mb-px h-10 border-b-2 border-transparent px-3 text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-primary'
          : 'h-8 rounded-md px-3 text-muted-foreground hover:text-foreground data-[state=active]:bg-surface data-[state=active]:text-foreground data-[state=active]:shadow-card',
        className,
      )}
      {...props}
    />
  )
})

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn('outline-none', className)} {...props} />
})
