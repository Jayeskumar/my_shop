import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { formatCombo, parseCombo, useHotkeys, useHotkeyScope, type HotkeyOptions } from './hotkeys'

function Bindings({ map, options }: { map: Record<string, () => void>; options?: HotkeyOptions }) {
  useHotkeys(map, options)
  return <input aria-label="field" />
}

function Scope({ name }: { name: string }) {
  useHotkeyScope(name)
  return null
}

const press = (
  key: string,
  init: KeyboardEventInit & { code?: string } = {},
  target: Element | Window = window,
) =>
  fireEvent.keyDown(target, {
    key,
    code: init.code ?? key,
    bubbles: true,
    cancelable: true,
    ...init,
  })

describe('parseCombo / formatCombo', () => {
  it('parses modifiers and aliases', () => {
    expect(parseCombo('ctrl+shift+p')).toMatchObject({ key: 'p', ctrl: true, shift: true })
    expect(parseCombo('Esc').key).toBe('escape')
    expect(parseCombo('mod+k')).toMatchObject({ key: 'k', mod: true })
    expect(formatCombo('mod+k', false)).toBe('Ctrl K')
    expect(formatCombo('mod+k', true)).toBe('⌘ K')
    expect(formatCombo('F2')).toBe('F2')
  })
})

describe('useHotkeys', () => {
  it('fires function keys (also from inputs) and prevents the browser default', () => {
    const onF2 = vi.fn()
    render(<Bindings map={{ F2: onF2 }} />)
    const event = new KeyboardEvent('keydown', {
      key: 'F2',
      code: 'F2',
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    expect(onF2).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    press('F2', {}, screen.getByLabelText('field'))
    expect(onF2).toHaveBeenCalledTimes(2)
  })

  it('ignores letter shortcuts while typing unless allowed', () => {
    const onSlash = vi.fn()
    const { unmount } = render(<Bindings map={{ '/': onSlash }} />)
    press('/', { code: 'Slash' }, screen.getByLabelText('field'))
    expect(onSlash).not.toHaveBeenCalled()
    press('/', { code: 'Slash' })
    expect(onSlash).toHaveBeenCalledTimes(1)
    unmount()
    render(<Bindings map={{ '/': onSlash }} options={{ allowInInputs: true }} />)
    press('/', { code: 'Slash' }, screen.getByLabelText('field'))
    expect(onSlash).toHaveBeenCalledTimes(2)
  })

  it('matches modifier combos exactly and works with Tamil keyboard layouts', () => {
    const onPrint = vi.fn()
    render(<Bindings map={{ 'ctrl+p': onPrint }} />)
    press('p', { code: 'KeyP' })
    expect(onPrint).not.toHaveBeenCalled()
    press('p', { code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(onPrint).not.toHaveBeenCalled()
    press('ப', { code: 'KeyP', ctrlKey: true }) // Tamil99 layout: physical P key
    expect(onPrint).toHaveBeenCalledTimes(1)
  })

  it('supports alternatives in one binding', () => {
    const save = vi.fn()
    render(<Bindings map={{ 'F12, ctrl+s': save }} />)
    press('F12')
    press('s', { code: 'KeyS', ctrlKey: true })
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('suspends scoped shortcuts while another scope (e.g. a dialog) is on top', () => {
    const onHold = vi.fn()
    const onGlobal = vi.fn()
    const { rerender } = render(
      <>
        <Scope name="pos" />
        <Bindings map={{ F4: onHold }} options={{ scope: 'pos' }} />
        <GlobalBinding fn={onGlobal} />
      </>,
    )
    press('F4')
    expect(onHold).toHaveBeenCalledTimes(1)
    rerender(
      <>
        <Scope name="pos" />
        <Bindings map={{ F4: onHold }} options={{ scope: 'pos' }} />
        <GlobalBinding fn={onGlobal} />
        <Scope name="dialog" />
      </>,
    )
    press('F4')
    press('F1')
    expect(onHold).toHaveBeenCalledTimes(1)
    expect(onGlobal).toHaveBeenCalledTimes(1)
  })

  it('does nothing when disabled', () => {
    const fn = vi.fn()
    render(<Bindings map={{ F9: fn }} options={{ enabled: false }} />)
    press('F9')
    expect(fn).not.toHaveBeenCalled()
  })
})

function GlobalBinding({ fn }: { fn: () => void }) {
  useHotkeys({ F1: fn })
  return null
}
