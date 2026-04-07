import { useContext } from 'react'
import { Stack, IconButton, Text } from '@fluentui/react'
import { Conversation, historyDelete, historyRename } from '../../api'
import { AppStateContext } from '../../state/AppProvider'
import styles from './ChatHistoryPanel.module.css'

export const ChatHistoryPanel = () => {
  const appStateContext = useContext(AppStateContext)
  const chatHistory = appStateContext?.state.chatHistory

  const onSelectConversation = (conv: Conversation) => {
    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conv })
  }

  const onDeleteConversation = async (conv: Conversation) => {
    await historyDelete(conv.id)
    appStateContext?.dispatch({ type: 'DELETE_CHAT_ENTRY', payload: conv.id })
  }

  return (
    <Stack className={styles.container}>
      <Stack horizontal horizontalAlign="space-between" verticalAlign="center" className={styles.header}>
        <Text className={styles.headerTitle}>Chat History</Text>
        <IconButton
          iconProps={{ iconName: 'Cancel' }}
          onClick={() => appStateContext?.dispatch({ type: 'TOGGLE_CHAT_HISTORY' })}
        />
      </Stack>
      <Stack className={styles.listContainer}>
        {chatHistory && chatHistory.length > 0 ? (
          chatHistory.map(conv => (
            <Stack
              key={conv.id}
              horizontal
              className={`${styles.listItem} ${
                appStateContext?.state.currentChat?.id === conv.id ? styles.listItemSelected : ''
              }`}
              onClick={() => onSelectConversation(conv)}
              verticalAlign="center">
              <Text className={styles.listItemTitle}>{conv.title}</Text>
              <IconButton
                iconProps={{ iconName: 'Delete' }}
                className={styles.deleteButton}
                onClick={e => {
                  e.stopPropagation()
                  onDeleteConversation(conv)
                }}
              />
            </Stack>
          ))
        ) : (
          <Text className={styles.emptyMessage}>No chat history</Text>
        )}
      </Stack>
    </Stack>
  )
}
