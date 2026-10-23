/**
 * Print button of an invoice / estimate / credit note: one click prints in the default format
 * (the counter's printer setting, else settings.invoice.print_format); the menu offers thermal
 * 80 / 58 mm or A4 and the print language. Printing uses the POS print templates
 * (printSalesDocument from features/pos/print), so reprints look exactly like the counter's.
 */
import { ChevronDown, Printer } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PrintFormat } from '@kadai/shared/settings'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  notify,
} from '@/components/ui'
import { printSalesDocument } from '@/features/pos/print'
import { getLanguage, type Language } from '@/lib/i18n'

const FORMATS: readonly PrintFormat[] = ['thermal_80', 'thermal_58', 'a4']

export function PrintMenu({
  kind,
  id,
  variant = 'outline',
}: {
  kind: 'invoice' | 'credit_note'
  id: string
  variant?: 'outline' | 'primary'
}) {
  const { t } = useTranslation('sales')
  const [busy, setBusy] = useState(false)
  const [locale, setLocale] = useState<Language>(getLanguage())

  const print = async (format?: PrintFormat): Promise<void> => {
    setBusy(true)
    try {
      await printSalesDocument({ kind, id, locale, ...(format ? { format } : {}) })
    } catch (error) {
      notify.error(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="inline-flex">
      <Button
        variant={variant}
        leftIcon={<Printer />}
        loading={busy}
        onClick={() => void print()}
        className="rounded-e-none"
      >
        {t('print.print')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant}
            className="rounded-s-none border-s-0 px-2"
            aria-label={t('print.options')}
            disabled={busy}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t('print.format')}</DropdownMenuLabel>
          {FORMATS.map((f) => (
            <DropdownMenuItem key={f} icon={<Printer />} onSelect={() => void print(f)}>
              {t(`print.format_${f}`)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{t('print.language')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(v) => setLocale(v === 'en' ? 'en' : 'ta')}
          >
            <DropdownMenuRadioItem value="ta" onSelect={(e) => e.preventDefault()}>
              தமிழ்
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en" onSelect={(e) => e.preventDefault()}>
              English
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
