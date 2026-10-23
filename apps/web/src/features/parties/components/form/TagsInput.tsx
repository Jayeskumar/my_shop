/**
 * Free-form tags as removable chips: Enter, comma or Tab adds the typed tag, Backspace on an
 * empty input removes the last one. Values are lower-cased and de-duplicated like the contract's
 * zTags (≤ 20 tags of ≤ 30 characters).
 */
import { X } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Input } from '@/components/ui'
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTag } from '../../lib/tags'

export function TagsInput({
  value,
  onChange,
  suggestions = [],
  disabled,
  id,
}: {
  value: readonly string[]
  onChange: (tags: string[]) => void
  suggestions?: readonly string[]
  disabled?: boolean
  id?: string
}) {
  const { t } = useTranslation('parties')
  const [text, setText] = useState('')

  const add = (raw: string): void => {
    const tag = normalizeTag(raw)
    setText('')
    if (!tag || value.includes(tag) || value.length >= MAX_TAGS) return
    onChange([...value, tag])
  }
  const remove = (tag: string): void => onChange(value.filter((x) => x !== tag))

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if ((e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) && text.trim()) {
      e.preventDefault()
      add(text)
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      remove(value[value.length - 1]!)
    }
  }

  const unused = suggestions.filter((s) => !value.includes(s)).slice(0, 6)

  return (
    <div className="grid gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('fields.tags')}>
          {value.map((tag) => (
            <li key={tag}>
              <Badge tone="primary" className="gap-1 pe-1">
                #{tag}
                <button
                  type="button"
                  className="inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15"
                  aria-label={t('tags.remove', { tag })}
                  onClick={() => remove(tag)}
                  disabled={disabled}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        id={id}
        value={text}
        disabled={disabled || value.length >= MAX_TAGS}
        placeholder={value.length >= MAX_TAGS ? t('tags.limit') : t('tags.placeholder')}
        maxLength={MAX_TAG_LENGTH + 5}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (text.trim()) add(text)
        }}
      />
      {unused.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('tags.suggestions')}</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              className="rounded-full border border-dashed border-border px-2 py-0.5 hover:border-primary hover:text-primary"
              onClick={() => add(s)}
              disabled={disabled}
            >
              #{s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
