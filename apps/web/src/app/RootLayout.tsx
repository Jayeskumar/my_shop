import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, ScrollRestoration } from 'react-router'
import { translate } from '@/lib/i18n'
import { useCurrentHandle } from './route-handles'

/** Top-level route element: document title from the route handle + scroll restoration. */
export function RootLayout() {
  const handle = useCurrentHandle()
  const { i18n } = useTranslation()
  useEffect(() => {
    const title = handle ? translate(handle.title) : ''
    document.title = title ? `${title} · StockSense` : 'StockSense'
  }, [handle, i18n.language])
  return (
    <>
      <Outlet />
      <ScrollRestoration />
    </>
  )
}
