/**
 * Public components of the notifications feature for other modules:
 *  - SendReminderDialog — customer due reminder (WhatsApp / SMS / own WhatsApp) with a Tamil /
 *    English preview, for the parties customer list and khata pages;
 *  - useCanSendReminder — permission check for showing the "Send reminder" action;
 *  - ChannelIcon / StatusChip / MessageBubble — to show messages consistently elsewhere.
 */
export {
  SendReminderDialog,
  type ReminderCustomer,
  type ReminderSummary,
  type SendReminderDialogProps,
} from './SendReminderDialog'
export { useCanSendReminder } from './use-can-send-reminder'
export { ChannelIcon } from './ChannelIcon'
export { StatusChip } from './StatusChip'
export { MessageBubble } from './MessageBubble'
