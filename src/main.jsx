import React from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import AppErrorBoundary, { StartupFailure } from './components/AppErrorBoundary.jsx'
import { installGlobalErrorHandlers, setClientErrorTransport } from './runtimeDiagnostics.js'
import { initTheme } from './theme/theme.js'
import { initBrandingFromCache } from './branding/brandingStore.js'

installGlobalErrorHandlers()

// Theme and cached institution colours are applied before the first render
// (a module, not an inline script, so the CSP keeps script-src 'self').
initTheme()
initBrandingFromCache()

// Send redacted incidents to the database (C18) when someone is signed in.
// Failures are ignored so reporting can never cause another error loop.
setClientErrorTransport(report => {
  import('./supabase.js')
    .then(async ({ supabase }) => {
      const { data } = await supabase.auth.getSession()
      if (!data?.session) return
      await supabase.rpc('record_client_error', { report_param: report })
    })
    .catch(() => {})
})

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Application root element is missing')
const root = ReactDOM.createRoot(rootElement)

import('./App.jsx')
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </React.StrictMode>,
    )
  })
  .catch(error => {
    root.render(<StartupFailure error={error} />)
  })
