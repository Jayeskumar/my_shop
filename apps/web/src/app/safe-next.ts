/** Only same-app relative paths are accepted as ?next= (no open redirects). */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return fallback
  return next
}
