import { act, fireEvent, render, screen } from '@testing-library/react'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import { FormField, Input } from '@/components/ui'

function BlurValidatedField() {
  const form = useForm<{ name: string }>({ defaultValues: { name: '' }, mode: 'onTouched' })
  return (
    <FormProvider {...form}>
      <FormField name="name" label="Name">
        <Input {...form.register('name', { required: 'Name is required' })} />
      </FormField>
      <a href="#next">Create a shop</a>
    </FormProvider>
  )
}

describe('useHeldWhilePointerDown (layout-stable validation)', () => {
  it('shows a blur error only after the click that caused the blur has completed', async () => {
    render(<BlurValidatedField />)
    const input = screen.getByLabelText('Name')
    const link = screen.getByRole('link', { name: 'Create a shop' })
    input.focus()

    // pointerdown on the link blurs the field: the error must not move the link yet
    fireEvent.pointerDown(link)
    await act(async () => {
      fireEvent.blur(input)
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.queryByRole('alert')).toBeNull()

    // after pointerup (+ the click it dispatches) the error appears
    await act(async () => {
      fireEvent.pointerUp(link)
      fireEvent.click(link)
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
  })

  it('updates immediately when no pointer is pressed (keyboard users)', async () => {
    render(<BlurValidatedField />)
    const input = screen.getByLabelText('Name')
    await act(async () => {
      fireEvent.blur(input)
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
  })
})
