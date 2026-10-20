/** Imperative confirm dialog: `const confirm = useConfirm(); if (await confirm({...})) …` */
import { createContext, useContext, type ReactNode } from 'react'

export interface ConfirmOptions {
  title: ReactNode
  description?: ReactNode
  confirmLabel?: ReactNode
  cancelLabel?: ReactNode
  tone?: 'danger' | 'primary'
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFn | null>(null)

/** Needs <ConfirmProvider> (mounted by the app providers). */
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext)
  if (!fn) throw new Error('useConfirm must be used inside <ConfirmProvider>')
  return fn
}
