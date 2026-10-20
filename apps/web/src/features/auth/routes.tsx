/** Routes of the auth (foundation) feature: sign-in, OTP, signup, password reset, setup, business choice. */
import { page, type FeatureRoutes } from '@/app/route-types'

export const routes: FeatureRoutes = {
  guest: [
    {
      path: 'login',
      handle: { title: 'nav:titles.login' },
      lazy: page(() => import('./pages/LoginPage')),
    },
    {
      path: 'otp',
      handle: { title: 'nav:titles.otp' },
      lazy: page(() => import('./pages/OtpLoginPage')),
    },
    {
      path: 'signup',
      handle: { title: 'nav:titles.signup' },
      lazy: page(() => import('./pages/SignupPage')),
    },
    {
      path: 'forgot-password',
      handle: { title: 'nav:titles.forgot_password' },
      lazy: page(() => import('./pages/ForgotPasswordPage')),
    },
    {
      path: 'setup',
      handle: { title: 'nav:titles.setup' },
      lazy: page(() => import('./pages/SetupPage')),
    },
  ],
  session: [
    {
      path: 'select-business',
      handle: { title: 'nav:titles.select_business' },
      lazy: page(() => import('./pages/SelectBusinessPage')),
    },
  ],
}
