/**
 * Layout-stable validation messages.
 *
 * A field validated on blur (react-hook-form `mode: 'onTouched'`) loses focus on the *pointerdown*
 * of whatever the user clicks next. If its error message appears right then, everything below it
 * moves, the pointerup lands on a different element and the click is silently lost — e.g. the
 * "Create a free shop account" link under the autofocused login field, or a dialog's Cancel
 * button under an empty required field.
 *
 * `useHeldWhilePointerDown(value)` keeps returning the value from before the press until the
 * pointer is released and the resulting click has been dispatched, then catches up.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'

let pressed = false
let installed = false
const listeners = new Set<() => void>()

function setPressed(next: boolean): void {
  if (pressed === next) return
  pressed = next
  for (const listener of listeners) listener()
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('pointerdown', () => setPressed(true), true)
  // `click` is dispatched right after pointerup in the same task; release after it.
  const release = (): void => {
    setTimeout(() => setPressed(false), 0)
  }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  // Never stay "pressed" when the window loses focus mid-press (alt-tab, devtools).
  window.addEventListener('blur', () => setPressed(false))
}

function subscribe(listener: () => void): () => void {
  install()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while a mouse button / finger / pen is pressed anywhere in the document. */
export function usePointerPressed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => pressed,
    () => false,
  )
}

/** `value`, frozen at its pre-press state while a pointer is pressed (see module comment). */
export function useHeldWhilePointerDown<T>(value: T): T {
  const isPressed = usePointerPressed()
  const [held, setHeld] = useState(value)
  useEffect(() => {
    if (!isPressed) setHeld(value)
  }, [isPressed, value])
  return isPressed ? held : value
}
