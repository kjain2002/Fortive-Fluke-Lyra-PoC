import { Action, AppState } from './AppProvider'

export const appStateReducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case 'TOGGLE_CHAT_HISTORY':
      return { ...state, isChatHistoryOpen: !state.isChatHistoryOpen }
    case 'UPDATE_CURRENT_CHAT':
      return { ...state, currentChat: action.payload }
    case 'UPDATE_CHAT_HISTORY_LOADING_STATE':
      return { ...state, chatHistoryLoadingState: action.payload }
    case 'UPDATE_CHAT_HISTORY':
      if (!state.chatHistory || !state.currentChat) return state
      const conversationIndex = state.chatHistory.findIndex(conv => conv.id === action.payload.id)
      if (conversationIndex !== -1) {
        const updatedChatHistory = [...state.chatHistory]
        updatedChatHistory[conversationIndex] = state.currentChat
        return { ...state, chatHistory: updatedChatHistory }
      } else {
        return { ...state, chatHistory: [...state.chatHistory, action.payload] }
      }
    case 'UPDATE_CHAT_TITLE':
      if (!state.chatHistory) return { ...state, chatHistory: [] }
      const updatedChats = state.chatHistory.map(chat => {
        if (chat.id === action.payload.id) {
          if (state.currentChat?.id === action.payload.id) {
            return { ...state.currentChat, title: action.payload.title }
          }
          return { ...chat, title: action.payload.title }
        }
        return chat
      })
      return { ...state, chatHistory: updatedChats }
    case 'DELETE_CHAT_ENTRY':
      if (!state.chatHistory) return state
      const filteredHistory = state.chatHistory.filter(conv => conv.id !== action.payload)
      const currentChat = state.currentChat?.id === action.payload ? null : state.currentChat
      return { ...state, chatHistory: filteredHistory, currentChat, filteredChatHistory: null }
    case 'DELETE_CHAT_HISTORY':
      return { ...state, chatHistory: [], filteredChatHistory: null, currentChat: null }
    case 'DELETE_CURRENT_CHAT_MESSAGES':
      if (!state.currentChat || state.currentChat.id !== action.payload) return state
      return { ...state, currentChat: { ...state.currentChat, messages: [] } }
    case 'FETCH_CHAT_HISTORY':
      return { ...state, chatHistory: action.payload }
    case 'SET_HISTORY_STATUS':
      return { ...state, isHistoryAvailable: action.payload }
    case 'FETCH_FRONTEND_SETTINGS':
      return { ...state, frontendSettings: action.payload }
    case 'SET_FEEDBACK_STATE':
      return {
        ...state,
        feedbackState: { ...state.feedbackState, [action.payload.answerId]: action.payload.feedback }
      }
    case 'UPDATE_FILTERED_CHAT_HISTORY':
      return { ...state, filteredChatHistory: action.payload }
    case 'OPEN_CHAT_CITATION_PANEL':
      return { ...state, isCitationPanelOpen: action.payload }
    case 'OPEN_ANSWER_CITATION_PANEL':
      return { ...state, isSubCitationPanelOpen: action.payload }
    case 'CLOSE_ALL_CITATION_PANELS':
      return { ...state, isCitationPanelOpen: false, isSubCitationPanelOpen: false }
    default:
      return state
  }
}
