import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route } from 'react-router-dom'
import { initializeIcons } from '@fluentui/react'
import { AppStateProvider } from './state/AppProvider'
import Layout from './pages/layout/Layout'
import Chat from './pages/chat/Chat'
import './index.css'

initializeIcons()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppStateProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Chat />} />
          </Route>
        </Routes>
      </HashRouter>
    </AppStateProvider>
  </React.StrictMode>
)
