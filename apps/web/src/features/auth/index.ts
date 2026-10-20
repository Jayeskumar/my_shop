/** Public surface of the auth feature for other modules (e.g. the POS uses the PIN switch). */
export { ChangePasswordDialog } from './components/ChangePasswordDialog'
export { PinPad } from './components/PinPad'
export { PinSwitchDialog, type PinSwitchDialogProps } from './components/PinSwitchDialog'
export { authApi, isSessionResponse, usePinUsers, useSetupStatus } from './api'
