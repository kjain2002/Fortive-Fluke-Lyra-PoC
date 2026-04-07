import { useContext } from 'react'
import { Outlet } from 'react-router-dom'
import { Stack, IconButton } from '@fluentui/react'
import { AppStateContext } from '../../state/AppProvider'
import { HistoryStatus } from '../../api'
import styles from './Layout.module.css'

const Layout = () => {
  const appStateContext = useContext(AppStateContext)
  const ui = appStateContext?.state.frontendSettings?.ui

  return (
    <div className={styles.layout}>
      <header className={styles.header} role="banner">
        <Stack horizontal verticalAlign="center" horizontalAlign="space-between" className={styles.headerContainer}>
          <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 12 }}>
            <h3 className={styles.headerTitle}>{ui?.title || 'Hierarchical Search'}</h3>
          </Stack>
          <Stack horizontal tokens={{ childrenGap: 8 }}>
            {appStateContext?.state.isHistoryAvailable?.status !== HistoryStatus.NotConfigured && (
              <IconButton
                iconProps={{ iconName: 'History' }}
                title="Chat History"
                onClick={() => appStateContext?.dispatch({ type: 'TOGGLE_CHAT_HISTORY' })}
                className={styles.historyButton}
              />
            )}
          </Stack>
        </Stack>
      </header>
      <Outlet />
    </div>
  )
}

export default Layout
