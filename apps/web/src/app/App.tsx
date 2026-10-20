import { useState } from 'react'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { AppProviders } from './providers'
import { buildRoutes } from './routes'

export function App() {
  const [router] = useState(() => createBrowserRouter(buildRoutes()))
  return (
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  )
}
