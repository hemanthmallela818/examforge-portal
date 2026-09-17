import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import AppErrorBoundary, { StartupFailure } from './components/AppErrorBoundary.jsx'
import { installGlobalErrorHandlers } from './runtimeDiagnostics.js'

installGlobalErrorHandlers()

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
