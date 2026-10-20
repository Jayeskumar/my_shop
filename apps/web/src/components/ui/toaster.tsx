import { Toaster as Sonner } from 'sonner'
import { useThemePreference } from '@/lib/theme'

/** Mount once (app providers). Use `notify.*` from './toast' to show toasts. */
export function Toaster() {
  const theme = useThemePreference()
  return (
    <Sonner
      theme={theme}
      position="top-center"
      richColors
      closeButton
      visibleToasts={4}
      offset={16}
      toastOptions={{
        classNames: {
          toast: 'font-sans text-sm shadow-overlay',
          title: 'font-semibold',
          description: 'text-[13px] opacity-90',
        },
      }}
    />
  )
}
