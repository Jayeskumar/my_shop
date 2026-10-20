import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { getLanguage, setLanguage, type Language } from '@/lib/i18n'

/** Segmented தமிழ் / English switch (saved on this device). */
export function LanguageToggle({ className, compact }: { className?: string; compact?: boolean }) {
  const { t, i18n } = useTranslation()
  const current: Language = i18n.resolvedLanguage === 'en' ? 'en' : getLanguage()
  const options: { value: Language; label: string; short: string }[] = [
    { value: 'ta', label: 'தமிழ்', short: 'த' },
    { value: 'en', label: 'English', short: 'EN' },
  ]
  return (
    <div
      role="radiogroup"
      aria-label={t('language.switch')}
      className={cn(
        'inline-flex items-center rounded-lg border border-border bg-surface-2 p-0.5',
        className,
      )}
    >
      {compact ? <Languages className="mx-1.5 size-4 text-muted-foreground" aria-hidden /> : null}
      {options.map((o) => {
        const active = current === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            lang={o.value}
            onClick={() => void setLanguage(o.value)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              o.value === 'ta' && 'font-tamil',
              active
                ? 'bg-surface text-foreground shadow-card'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {compact ? o.short : o.label}
          </button>
        )
      })}
    </div>
  )
}
