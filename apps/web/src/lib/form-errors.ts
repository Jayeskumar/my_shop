/**
 * Maps a server VALIDATION_ERROR (details.issues[].path) onto react-hook-form fields so errors
 * show inline next to the right input. Returns true when at least one field error was set.
 */
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { isApiError } from '@/lib/api'

export function applyServerFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  knownFields: readonly string[],
): boolean {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return false
  let applied = false
  for (const issue of error.validationIssues) {
    const field = issue.path.split('.')[0] ?? ''
    if (knownFields.includes(field)) {
      setError(issue.path as Path<T>, { type: 'server', message: issue.message })
      applied = true
    }
  }
  return applied
}
