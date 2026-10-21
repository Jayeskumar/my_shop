/**
 * Prescription details for scheduled drugs (H / H1 / X; settings.pharmacy.require_rx_for_schedules):
 * prescribing doctor (picked from the doctors list via the parties contract — or typed when
 * offline / new), registration number, patient name and age, prescription date. Stored on the
 * bill (rx) and printed on the receipt; the H1 register report reads it.
 */
import { zodResolver } from '@hookform/resolvers/zod'
import { Stethoscope } from 'lucide-react'
import { useState } from 'react'
import { Controller, FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { type Doctor, partiesRoutes } from '@kadai/shared/api/parties'
import { DoctorPicker } from '@/components/pickers'
import { Button, DatePicker, Dialog, FormField, Input, NumberInput, notify } from '@/components/ui'
import { callRoute } from '@/lib/api'
import { usePos } from '../state/pos-context'

const FormSchema = z.object({
  doctor_id: z.string().nullable(),
  doctor_name: z.string().trim().min(1).max(120),
  doctor_reg_no: z.string().trim().max(60),
  patient_name: z.string().trim().min(1).max(120),
  patient_age: z.number().int().min(0).max(130).nullable(),
  rx_date: z.string().nullable(),
})
type FormValues = z.infer<typeof FormSchema>

export function RxDialog({ onClose }: { onClose: (saved: boolean) => void }) {
  const { t } = useTranslation('pos')
  const pos = usePos()
  const rx = pos.cart.rx
  const [doctor, setDoctor] = useState<Doctor | null>(null)
  const [creatingDoctor, setCreatingDoctor] = useState(false)
  const pickDoctors = pos.online && pos.perms.customersRead
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      doctor_id: rx?.doctor_id ?? null,
      doctor_name: rx?.doctor_name ?? '',
      doctor_reg_no: rx?.doctor_reg_no ?? '',
      patient_name: rx?.patient_name ?? pos.cart.customer?.name ?? '',
      patient_age: rx?.patient_age ?? null,
      rx_date: rx?.rx_date ?? pos.today,
    },
  })

  const onSubmit = form.handleSubmit((v) => {
    pos.dispatch({
      type: 'set_rx',
      rx: {
        doctor_id: v.doctor_id,
        doctor_name: v.doctor_name,
        doctor_reg_no: v.doctor_reg_no || null,
        patient_name: v.patient_name,
        patient_age: v.patient_age,
        rx_date: v.rx_date,
      },
    })
    onClose(true)
  })

  const quickAddDoctor = async (name: string): Promise<void> => {
    setCreatingDoctor(true)
    try {
      const res = await callRoute(partiesRoutes.createDoctor, { body: { name } })
      setDoctor(res.data)
      form.setValue('doctor_id', res.data.id)
      form.setValue('doctor_name', res.data.name, { shouldValidate: true })
      notify.success(t('rx.doctor_added', { name: res.data.name }))
    } catch (e) {
      notify.error(e)
    } finally {
      setCreatingDoctor(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title={
        <span className="flex items-center gap-2">
          <Stethoscope className="size-5 text-primary" aria-hidden /> {t('rx.title')}
        </span>
      }
      description={t('rx.description')}
      size="md"
      dismissible={false}
      footer={
        <>
          {rx ? (
            <Button
              variant="ghost"
              onClick={() => {
                pos.dispatch({ type: 'set_rx', rx: null })
                onClose(false)
              }}
            >
              {t('rx.clear')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onClose(false)}>
            {t('rx.later')}
          </Button>
          <Button type="submit" form="pos-rx-form">
            {t('rx.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id="pos-rx-form" onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
          {pickDoctors ? (
            <FormField label={t('rx.doctor')} name="doctor_name" required className="sm:col-span-2">
              <DoctorPicker
                value={
                  doctor ??
                  (form.watch('doctor_id')
                    ? { id: form.watch('doctor_id') ?? '', name: form.watch('doctor_name') }
                    : null)
                }
                onChange={(d) => {
                  setDoctor(d)
                  form.setValue('doctor_id', d?.id ?? null)
                  form.setValue('doctor_name', d?.name ?? '', { shouldValidate: true })
                  form.setValue('doctor_reg_no', d?.registration_no ?? '')
                }}
                {...(pos.perms.customersWrite && !creatingDoctor
                  ? { onCreate: (q: string) => void quickAddDoctor(q) }
                  : {})}
              />
            </FormField>
          ) : (
            <FormField label={t('rx.doctor')} name="doctor_name" required className="sm:col-span-2">
              <Input {...form.register('doctor_name')} autoComplete="off" />
            </FormField>
          )}
          <FormField label={t('rx.reg_no')} name="doctor_reg_no" optional>
            <Input {...form.register('doctor_reg_no')} autoComplete="off" />
          </FormField>
          <FormField label={t('rx.date')} name="rx_date" optional>
            <Controller
              control={form.control}
              name="rx_date"
              render={({ field }) => (
                <DatePicker value={field.value} onChange={field.onChange} max={pos.today} />
              )}
            />
          </FormField>
          <FormField label={t('rx.patient')} name="patient_name" required>
            <Input {...form.register('patient_name')} autoComplete="off" />
          </FormField>
          <FormField label={t('rx.age')} name="patient_age" optional>
            <Controller
              control={form.control}
              name="patient_age"
              render={({ field }) => (
                <NumberInput value={field.value} onChange={field.onChange} min={0} max={130} />
              )}
            />
          </FormField>
        </form>
      </FormProvider>
    </Dialog>
  )
}
