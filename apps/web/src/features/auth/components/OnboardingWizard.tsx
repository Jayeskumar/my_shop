/**
 * Three-step onboarding wizard (shop type → business → owner) shared by cloud signup and the
 * on-prem first-run setup. One react-hook-form instance spans all steps; each "Next" validates
 * only that step's fields, and any error found on submit (client schema or server
 * VALIDATION_ERROR) jumps back to the step that owns the field.
 */
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Controller, FormProvider, type FieldErrors, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button, FormField } from '@/components/ui'
import { isApiError } from '@/lib/api'
import { validationToken } from '@/lib/validation'
import {
  businessGstIssues,
  STEP_FIELDS,
  stepOfField,
  type BusinessFormValues,
  type WizardStep,
} from '../business-rules'
import { BusinessDetailsFields } from './BusinessDetailsFields'
import { BusinessTypePicker } from './BusinessTypePicker'
import { OwnerFields } from './OwnerFields'
import { WizardStepper } from './WizardStepper'

const STEPS: WizardStep[] = ['business_type', 'business', 'owner']

export interface OnboardingWizardProps<TOut> {
  form: UseFormReturn<BusinessFormValues, unknown, TOut>
  /** On-prem setup: legal name, store name and (optionally) the setup code. */
  setup?: boolean
  setupToken?: boolean
  submitLabel: string
  submitting: boolean
  /** Throws to signal failure; server field errors are mapped by the wizard. */
  onSubmit: (values: TOut) => Promise<void>
  /** Shown above the submit button on the last step (e.g. licence note). */
  finalNote?: ReactNode
  /** Extra handling for server errors; return true when handled. */
  onServerError?: (error: unknown) => boolean
}

export function OnboardingWizard<TOut>({
  form,
  setup = false,
  setupToken = false,
  submitLabel,
  submitting,
  onSubmit,
  finalNote,
  onServerError,
}: OnboardingWizardProps<TOut>) {
  const { t } = useTranslation(['auth', 'common'])
  const [index, setIndex] = useState(0)
  const step = STEPS[index] ?? 'business_type'

  const goToFirstError = (errors: FieldErrors<BusinessFormValues>): void => {
    const first = Object.keys(errors)[0]
    const target = first ? stepOfField(first) : null
    if (target) setIndex(STEPS.indexOf(target))
  }

  const validateStep = async (s: WizardStep): Promise<boolean> => {
    const fields = STEP_FIELDS[s]
    const ok = await form.trigger(fields as (keyof BusinessFormValues)[])
    if (!ok) return false
    if (s === 'business') {
      const issues = businessGstIssues(form.getValues())
      for (const issue of issues)
        form.setError(issue.field, { type: 'rule', message: validationToken(issue.key) })
      if (issues.length > 0) return false
    }
    return true
  }

  const next = async (): Promise<void> => {
    if (await validateStep(step)) setIndex((i) => Math.min(STEPS.length - 1, i + 1))
  }

  const submit = form.handleSubmit(async (values) => {
    try {
      await onSubmit(values)
    } catch (error) {
      if (onServerError?.(error)) return
      if (
        isApiError(error) &&
        error.code === 'VALIDATION_ERROR' &&
        error.validationIssues.length > 0
      ) {
        let jumped = false
        for (const issue of error.validationIssues) {
          const target = stepOfField(issue.path)
          if (!target) continue
          form.setError(issue.path as keyof BusinessFormValues, {
            type: 'server',
            message: issue.message,
          })
          if (!jumped) {
            setIndex(STEPS.indexOf(target))
            jumped = true
          }
        }
        if (jumped) return
      }
      throw error
    }
  }, goToFirstError)

  const labels = STEPS.map((s) => ({ id: s, label: t(`signup.steps.${s}`) }))
  const isLast = index === STEPS.length - 1

  return (
    <FormProvider {...form}>
      <WizardStepper steps={labels} current={index} onStepClick={(i) => setIndex(i)} />
      <form
        noValidate
        onSubmit={(e) => {
          if (!isLast) {
            e.preventDefault()
            void next()
            return
          }
          void submit(e).catch(() => undefined)
        }}
        className="flex flex-col gap-6"
      >
        {step === 'business_type' ? (
          <section className="flex flex-col gap-4" aria-labelledby="step-type-title">
            <div>
              <h2 id="step-type-title" className="text-lg font-semibold">
                {t('signup.business_type_title')}
              </h2>
              <p className="text-sm text-muted-foreground">{t('signup.business_type_hint')}</p>
            </div>
            <FormField name="business_type">
              <Controller
                control={form.control}
                name="business_type"
                render={({ field, fieldState }) => (
                  <BusinessTypePicker
                    value={field.value}
                    onChange={(v) => {
                      field.onChange(v)
                      form.clearErrors('business_type')
                    }}
                    invalid={Boolean(fieldState.error)}
                    aria-labelledby="step-type-title"
                  />
                )}
              />
            </FormField>
          </section>
        ) : null}

        {step === 'business' ? (
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{t('signup.business_title')}</h2>
            <BusinessDetailsFields setup={setup} />
          </section>
        ) : null}

        {step === 'owner' ? (
          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t('signup.owner_title')}</h2>
            </div>
            <OwnerFields setupToken={setupToken} />
            {finalNote}
          </section>
        ) : null}

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          {index > 0 ? (
            <Button
              variant="ghost"
              size="lg"
              leftIcon={<ArrowLeft className="rtl:rotate-180" />}
              onClick={() => setIndex((i) => i - 1)}
              disabled={submitting}
            >
              {t('common:actions.back')}
            </Button>
          ) : (
            <span />
          )}
          {isLast ? (
            <Button
              type="submit"
              size="lg"
              loading={submitting}
              leftIcon={<Rocket />}
              className="sm:min-w-52"
            >
              {submitting ? t('signup.creating') : submitLabel}
            </Button>
          ) : (
            <Button
              type="submit"
              size="lg"
              rightIcon={<ArrowRight className="rtl:rotate-180" />}
              className="sm:min-w-40"
            >
              {t('common:actions.next')}
            </Button>
          )}
        </div>
      </form>
    </FormProvider>
  )
}
