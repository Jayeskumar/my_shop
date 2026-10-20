/**
 * Keyboard shortcuts (POS keyboard map: ARCHITECTURE.md §12).
 *
 *   useHotkeys({ F2: openSearch, 'ctrl+p': reprint, 'mod+k': palette }, { scope: 'pos' })
 *
 *  - Combos: modifiers `ctrl`, `alt`, `shift`, `meta`, `mod` (= ⌘ on macOS, Ctrl elsewhere) +
 *    a key (`F1`…`F12`, `esc`/`escape`, `enter`, `space`, `up`, `/`, letters, digits). Several
 *    alternatives can share a handler: `'F12, ctrl+s'`.
 *  - While typing in an input/textarea/select/contenteditable, bindings are ignored unless the
 *    binding allows it. Function keys F1–F12 are allowed by default (they never type text, and
 *    POS shortcuts must work from the qty/search fields); pass `allowInInputs` to change.
 *  - Scopes: bindings in scope 'global' always fire; any other scope fires only while it is the
 *    top of the active scope stack (`useHotkeyScope('dialog')` inside a modal suspends the page
 *    shortcuts underneath). Matching shortcuts call preventDefault (no browser F5 reload / Ctrl+P
 *    dialog) unless `preventDefault: false`.
 */
import { useEffect, useRef } from 'react'

export type HotkeyHandler = (event: KeyboardEvent) => void

export interface HotkeyOptions {
  enabled?: boolean
  /** 'global' (default) or a named scope. */
  scope?: string
  /** Fire while focus is in a text field (default: true for F-keys only). */
  allowInInputs?: boolean
  preventDefault?: boolean
}

export interface ParsedCombo {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  mod: boolean
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
}

export const isMac = (): boolean =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

export function parseCombo(combo: string): ParsedCombo {
  const parts = combo
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
  // "ctrl++" → last part is '' → the key is '+'
  const rawKey = parts.pop() || '+'
  const parsed: ParsedCombo = {
    key: KEY_ALIASES[rawKey] ?? rawKey,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    mod: false,
  }
  for (const m of parts) {
    if (m === 'ctrl' || m === 'control') parsed.ctrl = true
    else if (m === 'alt' || m === 'option') parsed.alt = true
    else if (m === 'shift') parsed.shift = true
    else if (m === 'meta' || m === 'cmd' || m === 'command') parsed.meta = true
    else if (m === 'mod') parsed.mod = true
  }
  return parsed
}

function eventKey(event: KeyboardEvent): string {
  const key = event.key.toLowerCase()
  // With Shift held, digits/letters keep their identity through `code` (e.g. shift+1 → '!').
  if (event.code.startsWith('Digit')) return event.code.slice(5)
  if (event.code.startsWith('Key') && key.length === 1) return event.code.slice(3).toLowerCase()
  return key
}

export function matchesCombo(event: KeyboardEvent, combo: ParsedCombo, mac = isMac()): boolean {
  const wantCtrl = combo.ctrl || (combo.mod && !mac)
  const wantMeta = combo.meta || (combo.mod && mac)
  if (event.ctrlKey !== wantCtrl) return false
  if (event.metaKey !== wantMeta) return false
  if (event.altKey !== combo.alt) return false
  // Shift is only compared for non-character keys and explicit shift combos.
  if (combo.shift !== event.shiftKey && (combo.shift || combo.key.length > 1)) return false
  return eventKey(event) === combo.key
}

export function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-2])$/.test(key)
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      type,
    )
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// Scope stack
// ---------------------------------------------------------------------------------------------

const scopeStack: string[] = []

/** Topmost active scope ('global' when none is pushed). */
export function activeHotkeyScope(): string {
  return scopeStack[scopeStack.length - 1] ?? 'global'
}

export function pushHotkeyScope(scope: string): () => void {
  scopeStack.push(scope)
  return () => {
    const i = scopeStack.lastIndexOf(scope)
    if (i !== -1) scopeStack.splice(i, 1)
  }
}

/** Activates `scope` while the component is mounted (and `enabled`). */
export function useHotkeyScope(scope: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    return pushHotkeyScope(scope)
  }, [scope, enabled])
}

// ---------------------------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------------------------

export type HotkeyMap = Record<string, HotkeyHandler>

/**
 * Registers keyboard shortcuts on window (keydown). Handlers can change every render; they are
 * read through a ref so the listener is attached once.
 */
export function useHotkeys(bindings: HotkeyMap, options: HotkeyOptions = {}): void {
  const { enabled = true, scope = 'global', allowInInputs, preventDefault = true } = options
  const bindingsRef = useRef(bindings)
  useEffect(() => {
    bindingsRef.current = bindings
  })

  const signature = Object.keys(bindings).sort().join('|')

  useEffect(() => {
    if (!enabled) return
    const parsed = Object.keys(bindingsRef.current).map((combos) => ({
      combos,
      alternatives: combos.split(',').map((c) => parseCombo(c.trim())),
    }))
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return
      if (scope !== 'global' && activeHotkeyScope() !== scope) return
      const typing = isTypingTarget(event.target)
      for (const { combos, alternatives } of parsed) {
        const hit = alternatives.find((c) => matchesCombo(event, c))
        if (!hit) continue
        const inputsOk = allowInInputs ?? isFunctionKey(hit.key)
        if (typing && !inputsOk) continue
        const handler = bindingsRef.current[combos]
        if (!handler) continue
        if (preventDefault) event.preventDefault()
        handler(event)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `signature` captures the set of combos; handlers are read from the ref.
  }, [enabled, scope, allowInInputs, preventDefault, signature])
}

/** Human label for a combo, e.g. 'mod+k' → 'Ctrl K' / '⌘ K'. */
export function formatCombo(combo: string, mac = isMac()): string {
  const c = parseCombo(combo)
  const parts: string[] = []
  if (c.ctrl || (c.mod && !mac)) parts.push('Ctrl')
  if (c.meta || (c.mod && mac)) parts.push(mac ? '⌘' : 'Win')
  if (c.alt) parts.push(mac ? '⌥' : 'Alt')
  if (c.shift) parts.push('Shift')
  const key =
    c.key === ' '
      ? 'Space'
      : c.key === 'escape'
        ? 'Esc'
        : c.key.length === 1
          ? c.key.toUpperCase()
          : c.key.replace(/^f(\d+)$/, 'F$1').replace(/^arrow/, '')
  parts.push(key.charAt(0).toUpperCase() + key.slice(1))
  return parts.join(' ')
}
