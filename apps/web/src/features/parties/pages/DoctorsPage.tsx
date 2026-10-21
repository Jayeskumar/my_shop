/**
 * Prescribing doctors (/parties/doctors, pharmacy tenants only — the route guard hides it for
 * other verticals). Doctors are picked on Schedule H / H1 / X bills and printed in the H1
 * register. List with search, add / edit dialog, deactivate / delete with confirmation.
 */
import { MoreHorizontal, Pencil, Plus, RotateCcw, Stethoscope, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type Doctor,
  type DoctorCreate,
  DoctorCreateSchema,
  type DoctorUpdate,
  DoctorUpdateSchema,
} from '@kadai/shared/api/parties'
import { newId } from '@kadai/shared/ids'
import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  PhoneLink,
  SearchInput,
  notify,
  useConfirm,
} from '@/components/ui'
import { isApiError } from '@/lib/api'
import { useCan } from '@/lib/auth'
import { formatPhone } from '@/lib/format'
import { useHotkeyScope, useHotkeys } from '@/lib/hotkeys'
import { useCreateDoctor, useDeleteDoctor, useDoctors, useUpdateDoctor } from '../api'
import { FilterChips } from '../components/FilterChips'
import { AddressFields } from '../components/form/AddressFields'
import { PartyField } from '../components/form/PartyField'
import {
  type AddressFormValues,
  addressFromRecord,
  addressToBody,
  contractResolver,
  EMPTY_ADDRESS,
  textOrNull,
} from '../lib/forms'
import { formatAddress, langOf, PARTIES_HOTKEY_SCOPE } from '../lib/labels'
import { LIST_PAGE_SIZES, useListState } from '../lib/use-list-state'

const FILTERS = ['active', 'inactive'] as const
type DoctorFilter = (typeof FILTERS)[number]

export default function DoctorsPage() {
  const { t, i18n } = useTranslation(['parties', 'common'])
  const canWrite = useCan('customers.write')
  const confirm = useConfirm()
  const searchRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<Doctor | 'new' | null>(null)
  const [state, setState] = useListState<DoctorFilter>({
    filter: 'active',
    filters: FILTERS,
    sort: 'name',
    sorts: ['name', 'created_at'],
  })
  const list = useDoctors({
    limit: state.limit,
    offset: state.offset,
    sort: state.sort,
    is_active: state.filter === 'active',
    ...(state.q ? { q: state.q } : {}),
  })
  const del = useDeleteDoctor()
  const update = useUpdateDoctor()

  useHotkeyScope(PARTIES_HOTKEY_SCOPE)
  useHotkeys(
    {
      'alt+n': () => {
        if (canWrite) setEditing('new')
      },
      '/': () => searchRef.current?.focus(),
    },
    { scope: PARTIES_HOTKEY_SCOPE },
  )

  const remove = async (d: Doctor): Promise<void> => {
    const ok = await confirm({
      title: t('doctors.delete_title', { name: d.name }),
      description: t('doctors.delete_description'),
      confirmLabel: t('khata.delete_confirm'),
      tone: 'danger',
    })
    if (!ok) return
    del.mutate(
      { params: { id: d.id } },
      {
        onSuccess: (res) =>
          res.data.result === 'deleted'
            ? notify.success(t('khata.deleted', { name: d.name }))
            : notify.info(t('doctors.deactivated', { name: d.name })),
        onError: (e) => notify.error(e),
      },
    )
  }

  const reactivate = (d: Doctor): void =>
    update.mutate(
      { params: { id: d.id }, body: { is_active: true, if_updated_at: d.updated_at } },
      {
        onSuccess: () => notify.success(t('khata.reactivated', { name: d.name })),
        onError: (e) => notify.error(e),
      },
    )

  const columns = useMemo<DataTableColumn<Doctor>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('fields.doctor_name'),
        enableSorting: true,
        meta: { mobile: 'title' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{row.original.name}</span>
              {!row.original.is_active ? (
                <Badge size="sm">{t('common:status.inactive')}</Badge>
              ) : null}
            </div>
            {row.original.qualification ? (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.qualification}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'registration_no',
        header: t('fields.registration_no'),
        meta: { mobile: 'subtitle', label: t('fields.registration_no') },
        cell: ({ row }) =>
          row.original.registration_no ? (
            <span className="font-mono text-sm">{row.original.registration_no}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'clinic',
        header: t('fields.clinic_name'),
        meta: { label: t('fields.clinic_name') },
        cell: ({ row }) => (
          <div className="min-w-0 text-sm">
            <div className="truncate">{row.original.clinic_name ?? '—'}</div>
            {formatAddress(row.original.address, langOf(i18n.language)) ? (
              <div className="truncate text-xs text-muted-foreground">
                {formatAddress(row.original.address, langOf(i18n.language))}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'phone',
        header: t('fields.phone'),
        meta: { label: t('fields.phone') },
        cell: ({ row }) => <PhoneLink phone={row.original.phone} />,
      },
      ...(canWrite
        ? [
            {
              id: 'actions',
              header: '',
              meta: { align: 'right' as const, mobile: 'hidden' as const },
              cell: ({ row }: { row: { original: Doctor } }) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      icon={<MoreHorizontal />}
                      label={t('common:actions.more')}
                      size="sm"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(row.original)}>
                      {t('common:actions.edit')}
                    </DropdownMenuItem>
                    {row.original.is_active ? (
                      <DropdownMenuItem
                        icon={<Trash2 />}
                        tone="danger"
                        onSelect={() => void remove(row.original)}
                      >
                        {t('profile.delete')}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        icon={<RotateCcw />}
                        onSelect={() => reactivate(row.original)}
                      >
                        {t('profile.reactivate')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
            } satisfies DataTableColumn<Doctor>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remove/reactivate are stable enough per render
    [t, i18n.language, canWrite],
  )

  const firstRun =
    state.filter === 'active' &&
    !state.q &&
    !list.isLoading &&
    !list.error &&
    list.data?.page.total === 0

  return (
    <div>
      <PageHeader
        title={t('doctors.title')}
        description={t('doctors.description')}
        actions={
          canWrite ? (
            <Button leftIcon={<Plus />} onClick={() => setEditing('new')}>
              {t('doctors.add')}
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center">
        <SearchInput
          ref={searchRef}
          value={state.q}
          onChange={(q) => setState({ q })}
          placeholder={t('doctors.search_placeholder')}
          wrapperClassName="sm:max-w-sm"
        />
        <FilterChips
          chips={FILTERS.map((key) => ({ key, label: t(`doctors.filter_${key}`) }))}
          value={state.filter}
          onChange={(filter) => setState({ filter })}
          label={t('customers.filters_label')}
        />
      </div>
      {firstRun ? (
        <div className="rounded-xl border border-dashed border-border bg-surface">
          <EmptyState
            icon={<Stethoscope />}
            title={t('doctors.empty_title')}
            description={t('doctors.empty_description')}
            action={
              canWrite ? (
                <Button leftIcon={<Plus />} onClick={() => setEditing('new')}>
                  {t('doctors.add_first')}
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <DataTable
          label={t('doctors.title')}
          columns={columns}
          data={list.data?.data ?? []}
          getRowId={(d) => d.id}
          loading={list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          onRowClick={canWrite ? (d) => setEditing(d) : undefined}
          sort={state.sort}
          onSortChange={(sort) => setState({ sort: sort ?? 'name' })}
          pagination={
            list.data
              ? {
                  ...list.data.page,
                  pageSizeOptions: LIST_PAGE_SIZES,
                  onChange: ({ offset, limit }) => setState({ offset, limit }),
                }
              : undefined
          }
          empty={
            <EmptyState
              compact
              icon={<Stethoscope />}
              title={t('doctors.none')}
              description={t('customers.none_hint')}
            />
          }
        />
      )}
      <DoctorFormDialog
        open={editing !== null}
        doctor={editing === 'new' ? null : editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null)
        }}
      />
    </div>
  )
}

interface DoctorFormValues {
  name: string
  registration_no: string
  qualification: string
  phone: string
  clinic_name: string
  address: AddressFormValues
}

function doctorToValues(d: Doctor | null): DoctorFormValues {
  return {
    name: d?.name ?? '',
    registration_no: d?.registration_no ?? '',
    qualification: d?.qualification ?? '',
    phone: d?.phone ? formatPhone(d.phone) : '',
    clinic_name: d?.clinic_name ?? '',
    address: d ? addressFromRecord(d.address) : { ...EMPTY_ADDRESS },
  }
}

function doctorBody(v: DoctorFormValues, stateCode: string | null): DoctorCreate {
  return {
    name: v.name,
    registration_no: textOrNull(v.registration_no),
    qualification: textOrNull(v.qualification),
    phone: textOrNull(v.phone),
    clinic_name: textOrNull(v.clinic_name),
    address: addressToBody(v.address, stateCode),
  }
}

function doctorPatch(v: DoctorFormValues, initial: DoctorFormValues, d: Doctor): DoctorUpdate {
  const stateCode = d.address.state_code ?? null
  const body = doctorBody(v, stateCode)
  const before = doctorBody(initial, stateCode)
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(body) as (keyof DoctorCreate)[]) {
    if (JSON.stringify(body[key]) !== JSON.stringify(before[key])) patch[key] = body[key]
  }
  return { ...(patch as DoctorUpdate), if_updated_at: d.updated_at }
}

function DoctorFormDialog({
  open,
  onOpenChange,
  doctor,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  doctor: Doctor | null
}) {
  if (!open) return null
  return <DoctorFormBody onOpenChange={onOpenChange} doctor={doctor} />
}

function DoctorFormBody({
  onOpenChange,
  doctor,
}: {
  onOpenChange: (open: boolean) => void
  doctor: Doctor | null
}) {
  const { t } = useTranslation(['parties', 'common'])
  const formId = useRef(`doctor-${newId()}`).current
  // One key per dialog session: a double tap or a retry after a timeout never adds a duplicate.
  const idempotencyKey = useRef(newId()).current
  const initial = useMemo(() => doctorToValues(doctor), [doctor])
  const form = useForm<DoctorFormValues>({
    defaultValues: initial,
    mode: 'onTouched',
    resolver: doctor
      ? contractResolver<DoctorFormValues>(DoctorUpdateSchema, (v) =>
          doctorPatch(v, initial, doctor),
        )
      : contractResolver<DoctorFormValues>(DoctorCreateSchema, (v) => doctorBody(v, null)),
  })
  const create = useCreateDoctor()
  const update = useUpdateDoctor()
  const saving = create.isPending || update.isPending

  const onError = (error: unknown): void => {
    if (isApiError(error) && error.is('DUPLICATE')) {
      form.setError('registration_no', { type: 'server', message: 'duplicate_registration' })
      return
    }
    notify.error(error)
  }

  const onSubmit = form.handleSubmit(
    (values) => {
      if (doctor) {
        update.mutate(
          { params: { id: doctor.id }, body: doctorPatch(values, initial, doctor) },
          {
            onSuccess: () => {
              notify.success(t('doctors.updated', { name: values.name }))
              onOpenChange(false)
            },
            onError,
          },
        )
      } else {
        create.mutate(
          { body: doctorBody(values, null), idempotencyKey },
          {
            onSuccess: (res) => {
              notify.success(t('doctors.created', { name: res.data.name }))
              onOpenChange(false)
            },
            onError,
          },
        )
      }
    },
    (errors) => {
      if (errors.root?.message === 'empty_patch') onOpenChange(false)
    },
  )

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!saving) onOpenChange(o)
      }}
      title={doctor ? t('doctors.edit_title') : t('doctors.add_title')}
      size="lg"
      dismissible={!form.formState.isDirty}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {doctor ? t('common:actions.save_changes') : t('doctors.save')}
          </Button>
        </>
      }
    >
      <FormProvider {...form}>
        <form id={formId} onSubmit={onSubmit} noValidate className="grid gap-5 pb-2 [&>*]:min-w-0">
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <PartyField
              name="name"
              label={t('fields.doctor_name')}
              required
              className="sm:col-span-2"
            >
              <Input
                autoFocus
                autoComplete="off"
                placeholder={t('placeholders.doctor_name')}
                startAdornment={<Stethoscope />}
                {...form.register('name')}
              />
            </PartyField>
            <PartyField
              name="registration_no"
              label={t('fields.registration_no')}
              optional
              hint={t('doctors.registration_hint')}
            >
              <Input
                autoComplete="off"
                maxLength={40}
                className="font-mono"
                {...form.register('registration_no')}
              />
            </PartyField>
            <PartyField name="qualification" label={t('fields.qualification')} optional>
              <Input
                autoComplete="off"
                placeholder="MBBS, MD"
                {...form.register('qualification')}
              />
            </PartyField>
            <PartyField name="clinic_name" label={t('fields.clinic_name')} optional>
              <Input autoComplete="off" {...form.register('clinic_name')} />
            </PartyField>
            <PartyField name="phone" label={t('fields.phone')} optional>
              <Input type="tel" inputMode="tel" autoComplete="off" {...form.register('phone')} />
            </PartyField>
          </div>
          <AddressFields />
        </form>
      </FormProvider>
    </Dialog>
  )
}
