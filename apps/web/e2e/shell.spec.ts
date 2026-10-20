import { expect, test } from '@playwright/test'
import { mockApi } from './fixtures'

test('serves the PWA manifest and service worker', async ({ request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest.name).toBe('Kadai — கடை')
  expect(manifest.theme_color).toBe('#0F766E')
  expect(manifest.icons.map((i: { src: string }) => i.src)).toEqual(
    expect.arrayContaining(['/pwa-192.png', '/pwa-512.png', '/pwa-maskable-512.png']),
  )
  const sw = await request.get('/sw.js')
  expect(sw.ok()).toBe(true)
  // The POS bootstrap is the only API response the service worker may cache.
  expect(await sw.text()).toContain('kadai-pos-bootstrap')
})

test('opens in Tamil by default and switches to English', async ({ page }) => {
  await mockApi(page, { signedIn: false })
  await page.goto('/')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'நல்வரவு' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ta')
  await page.getByRole('radio', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
})

test('signs in and lands in the shell with role-filtered navigation', async ({
  page,
  isMobile,
}) => {
  await mockApi(page, { signedIn: false })
  await page.addInitScript(() => localStorage.setItem('kadai.lang', JSON.stringify('en')))
  await page.goto('/login')
  await page.getByLabel(/Mobile number or email/).fill('9876543210')
  await page.getByLabel(/^Password/).fill('secret-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
  if (isMobile) {
    await page.getByRole('button', { name: 'Menu' }).last().click()
  }
  const nav = isMobile
    ? page.getByRole('dialog')
    : page.getByRole('complementary', { name: 'Main navigation' })
  await expect(nav.getByText('Sales invoices')).toBeVisible()
  await expect(nav.getByText('Purchase bills')).toHaveCount(0) // not in the Free plan
  await expect(nav.getByText('Users')).toHaveCount(0) // cashier
})

test('walks the signup wizard steps', async ({ page }) => {
  await mockApi(page, { signedIn: false })
  await page.addInitScript(() => localStorage.setItem('kadai.lang', JSON.stringify('en')))
  await page.goto('/signup')
  await page.getByRole('radio', { name: /Pharmacy/ }).click()
  await page.getByRole('button', { name: /Next/ }).click()
  await expect(page.getByRole('heading', { name: 'Tell us about your business' })).toBeVisible()
  await page.getByLabel(/Shop \/ business name/).fill('Lakshmi Medicals')
  await page.getByRole('button', { name: /Next/ }).click()
  await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create my shop' })).toBeVisible()
})
