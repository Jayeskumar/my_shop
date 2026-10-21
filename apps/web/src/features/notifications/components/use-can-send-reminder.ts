import { useCan } from '@/lib/auth'

/**
 * Whether the signed-in member may send due reminders (POST /customers/:id/remind needs
 * customers.write) — hide the "Send reminder" action otherwise.
 */
export function useCanSendReminder(): boolean {
  return useCan('customers.write')
}
