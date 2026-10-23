/**
 * Logo picker for the business profile: preview (stored file fetched with auth, or the freshly
 * uploaded one), upload with the contract's client-side checks (type / size), remove. The
 * value is a file id (`logo_file_id`); the upload happens immediately, the profile PATCH on save.
 */
import { ImageUp, Store, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FILE_UPLOAD_PERMISSIONS,
  FILE_UPLOAD_RULES,
  fileUploadIssue,
} from '@kadai/shared/api/identity'
import { Button, Skeleton, Spinner } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { uploadFile, useFileObjectUrl } from '../api'
import { notifySettingsError, useValidationKeyText } from '../lib/messages'

export function LogoField({
  value,
  onChange,
  disabled,
}: {
  value: string | null
  onChange: (fileId: string | null) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('settings')
  const keyText = useValidationKeyText()
  const canUpload = useCan(FILE_UPLOAD_PERMISSIONS.logo)
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  // Preview of a just-uploaded file (no round trip for its content).
  const [local, setLocal] = useState<{ id: string; url: string } | null>(null)
  const stored = useFileObjectUrl(local?.id === value ? null : value)

  useEffect(() => {
    return () => {
      if (local) URL.revokeObjectURL(local.url)
    }
  }, [local])

  const previewUrl = value ? (local?.id === value ? local.url : stored.url) : null
  const rule = FILE_UPLOAD_RULES.logo

  const pick = async (file: File): Promise<void> => {
    const problem = fileUploadIssue('logo', file)
    if (problem) {
      setIssue(problem)
      return
    }
    setIssue(null)
    setUploading(true)
    try {
      const uploaded = await uploadFile(file, 'logo')
      setLocal({ id: uploaded.id, url: URL.createObjectURL(file) })
      onChange(uploaded.id)
    } catch (error) {
      // The server re-checks type, size and content (magic bytes): show its key inline.
      const fileIssue = isApiError(error)
        ? error.validationIssues.find((i) => i.path === 'file')
        : undefined
      if (fileIssue) setIssue(fileIssue.code ?? fileIssue.message)
      else notifySettingsError(error)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4">
        <div className="flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-surface-2">
          {uploading ? (
            <Spinner label={t('logo.uploading')} />
          ) : value && stored.loading && !previewUrl ? (
            <Skeleton className="size-full" />
          ) : previewUrl ? (
            <img
              src={previewUrl}
              alt={t('logo.preview_alt')}
              className="size-full object-contain"
            />
          ) : (
            <Store className="size-8 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {canUpload && !disabled ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                leftIcon={<ImageUp />}
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                {value ? t('logo.change') : t('logo.upload')}
              </Button>
              {value ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  leftIcon={<Trash2 />}
                  onClick={() => {
                    setIssue(null)
                    onChange(null)
                  }}
                  disabled={uploading}
                >
                  {t('logo.remove')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('logo.hint', { size: Math.round(rule.max_bytes / (1024 * 1024)) })}
          </p>
        </div>
      </div>
      {issue ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {keyText(issue) ?? issue}
        </p>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={rule.accept}
        className="sr-only"
        tabIndex={-1}
        aria-label={t('logo.upload')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void pick(file)
        }}
      />
    </div>
  )
}
