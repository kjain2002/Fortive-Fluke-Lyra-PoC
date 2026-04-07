import React, { createContext, ReactNode, useEffect, useReducer } from 'react'
import {
  ChatHistoryLoadingState,
  Conversation,
  HistoryHealth,
  HistoryStatus,
  Feedback,
  FrontendSettings,
  frontendSettings,
  historyEnsure,
  historyList
} from '../api'
import { appStateReducer } from './AppReducer'

export interface AppState {
  isChatHistoryOpen: boolean
  chatHistoryLoadingState: ChatHistoryLoadingState
  isHistoryAvailable: HistoryHealth
  chatHistory: Conversation[] | null
  filteredChatHistory: Conversation[] | null
  currentChat: Conversation | null
  frontendSettings: FrontendSettings | null
  feedbackState: { [answerId: string]: Feedback.Neutral | Feedback.Positive | Feedback.Negative }
  isCitationPanelOpen: boolean
  isSubCitationPanelOpen: boolean
}

export type Action =
  | { type: 'TOGGLE_CHAT_HISTORY' }
  | { type: 'SET_HISTORY_STATUS'; payload: HistoryHealth }
  | { type: 'UPDATE_CHAT_HISTORY_LOADING_STATE'; payload: ChatHistoryLoadingState }
  | { type: 'UPDATE_CURRENT_CHAT'; payload: Conversation | null }
  | { type: 'UPDATE_FILTERED_CHAT_HISTORY'; payload: Conversation[] | null }
  | { type: 'UPDATE_CHAT_HISTORY'; payload: Conversation }
  | { type: 'UPDATE_CHAT_TITLE'; payload: Conversation }
  | { type: 'DELETE_CHAT_ENTRY'; payload: string }
  | { type: 'DELETE_CHAT_HISTORY' }
  | { type: 'DELETE_CURRENT_CHAT_MESSAGES'; payload: string }
  | { type: 'FETCH_CHAT_HISTORY'; payload: Conversation[] | null }
  | { type: 'FETCH_FRONTEND_SETTINGS'; payload: FrontendSettings | null }
  | { type: 'SET_FEEDBACK_STATE'; payload: { answerId: string; feedback: Feedback.Positive | Feedback.Negative | Feedback.Neutral } }
  | { type: 'GET_FEEDBACK_STATE'; payload: string }
  | { type: 'OPEN_CHAT_CITATION_PANEL'; payload: boolean }
  | { type: 'OPEN_ANSWER_CITATION_PANEL'; payload: boolean }
  | { type: 'CLOSE_ALL_CITATION_PANELS' }

const initialState: AppState = {
  isChatHistoryOpen: false,
  chatHistoryLoadingState: ChatHistoryLoadingState.Loading,
  chatHistory: null,
  filteredChatHistory: null,
  currentChat: null,
  isHistoryAvailable: { foundry: false, status: HistoryStatus.NotConfigured },
  frontendSettings: null,
  feedbackState: {},
  isCitationPanelOpen: false,
  isSubCitationPanelOpen: false
}

export const AppStateContext = createContext<
  { state: AppState; dispatch: React.Dispatch<Action> } | undefined
>(undefined)

type AppStateProviderProps = { children: ReactNode }

export const AppStateProvider: React.FC<AppStateProviderProps> = ({ children }) => {
  const [state, dispatch] = useReducer(appStateReducer, initialState)

  useEffect(() => {
    const fetchChatHistory = async (offset = 0): Promise<Conversation[] | null> => {
      try {
        const response = await historyList(offset)
        dispatch({ type: 'FETCH_CHAT_HISTORY', payload: response })
        return response
      } catch {
        dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Fail })
        dispatch({ type: 'FETCH_CHAT_HISTORY', payload: null })
        return null
      }
    }

    const getHistoryEnsure = async () => {
      dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Loading })
      try {
        const response = await historyEnsure()
        if (response?.foundry) {
          const res = await fetchChatHistory()
          if (res) {
            dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Success })
            dispatch({ type: 'SET_HISTORY_STATUS', payload: response })
          } else {
            dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Fail })
            dispatch({ type: 'SET_HISTORY_STATUS', payload: { foundry: false, status: HistoryStatus.NotWorking } })
          }
        } else {
          dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Fail })
          dispatch({ type: 'SET_HISTORY_STATUS', payload: response })
        }
      } catch {
        dispatch({ type: 'UPDATE_CHAT_HISTORY_LOADING_STATE', payload: ChatHistoryLoadingState.Fail })
        dispatch({ type: 'SET_HISTORY_STATUS', payload: { foundry: false, status: HistoryStatus.NotConfigured } })
      }
    }
    getHistoryEnsure()
  }, [])

  useEffect(() => {
    const getFrontendSettings = async () => {
      try {
        const response = await frontendSettings()
        dispatch({ type: 'FETCH_FRONTEND_SETTINGS', payload: response as FrontendSettings })
      } catch {
        console.error('There was an issue fetching frontend settings.')
      }
    }
    getFrontendSettings()
  }, [])

  return <AppStateContext.Provider value={{ state, dispatch }}>{children}</AppStateContext.Provider>
}
