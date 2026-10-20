import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton, type IconButtonProps } from './icon-button'

/** Copies text to the clipboard; falls back to a hidden textarea on insecure (LAN http) origins. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  // On-prem installs are often served over plain http on the shop LAN (no Clipboard API).
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

export interface CopyButtonProps extends Omit<IconButtonProps, 'icon' | 'label' | 'onClick'> {
  value: string
  label?: string
  onCopied?: () => void
}

export function CopyButton({ value, label, onCopied, size = 'sm', ...props }: CopyButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconButton
      size={size}
      label={copied ? t('actions.copied') : (label ?? t('actions.copy'))}
      icon={copied ? <Check className="text-success" /> : <Copy />}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyToClipboard(value)) {
          setCopied(true)
          onCopied?.()
        }
      }}
      {...props}
    />
  )
}
