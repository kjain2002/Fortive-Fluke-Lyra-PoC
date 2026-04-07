import { useRef, useState, useEffect, useContext, useLayoutEffect } from 'react'
import { IconButton, Dialog, DialogType, Stack, CommandBarButton } from '@fluentui/react'
import { Spinner, SpinnerSize } from '@fluentui/react/lib/Spinner'
import { SquareRegular, ShieldLockRegular, ErrorCircleRegular } from '@fluentui/react-icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import uuid from 'react-uuid'
import { isEmpty } from 'lodash'
import DOMPurify from 'dompurify'

import styles from './Chat.module.css'

import {
  ChatMessage,
  ConversationRequest,
  conversationApi,
  Citation,
  ToolMessageContent,
  ChatResponse,
  getUserInfo,
  Conversation,
  historyGenerate,
  historyUpdate,
  historyClear,
  ChatHistoryLoadingState,
  HistoryStatus,
  ErrorMessage,
} from '../../api'
import { Answer } from '../../components/Answer'
import { QuestionInput } from '../../components/QuestionInput'
import { ChatHistoryPanel } from '../../components/ChatHistory/ChatHistoryPanel'
import { AppStateContext } from '../../state/AppProvider'
import { useBoolean } from '@fluentui/react-hooks'
import { initializeIcons } from '@fluentui/react'
initializeIcons('https://res.cdn.office.net/files/fabric-cdn-prod_20240129.001/assets/icons/')

const enum messageStatus {
  NotRunning = 'Not Running',
  Processing = 'Processing',
  Done = 'Done'
}

const Chat = () => {
  const appStateContext = useContext(AppStateContext)
  const ui = appStateContext?.state.frontendSettings?.ui
  const AUTH_ENABLED = appStateContext?.state.frontendSettings?.auth_enabled
  const chatMessageStreamEnd = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [showLoadingMessage, setShowLoadingMessage] = useState<boolean>(false)
  const [activeCitation, setActiveCitation] = useState<Citation>()
  const isCitationPanelOpen = appStateContext?.state?.isCitationPanelOpen

  const abortFuncs = useRef([] as AbortController[])
  const [showAuthMessage, setShowAuthMessage] = useState<boolean | undefined>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [processMessages, setProcessMessages] = useState<messageStatus>(messageStatus.NotRunning)
  const [clearingChat, setClearingChat] = useState<boolean>(false)
  const [hideErrorDialog, { toggle: toggleErrorDialog }] = useBoolean(true)
  const [errorMsg, setErrorMsg] = useState<ErrorMessage | null>()
  const [loadingProgress, setLoadingProgress] = useState(0)

  const errorDialogContentProps = {
    type: DialogType.close,
    title: errorMsg?.title,
    closeButtonAriaLabel: 'Close',
    subText: errorMsg?.subtitle
  }

  const modalProps = {
    titleAriaId: 'labelId',
    subtitleAriaId: 'subTextId',
    isBlocking: true,
    styles: { main: { maxWidth: 450 } }
  }

  const [ASSISTANT, TOOL, ERROR] = ['assistant', 'tool', 'error']
  const NO_CONTENT_ERROR = 'No content in messages object.'

  useEffect(() => {
    if (
      appStateContext?.state.isHistoryAvailable?.status !== HistoryStatus.Working &&
      appStateContext?.state.isHistoryAvailable?.status !== HistoryStatus.NotConfigured &&
      appStateContext?.state.chatHistoryLoadingState === ChatHistoryLoadingState.Fail &&
      hideErrorDialog
    ) {
      setErrorMsg({
        title: 'Chat history is not enabled',
        subtitle: `${appStateContext.state.isHistoryAvailable.status}. Please contact the site administrator.`
      })
      toggleErrorDialog()
    }
  }, [appStateContext?.state.isHistoryAvailable])

  useEffect(() => {
    if (showLoadingMessage) {
      const dynamicMax = Math.floor(75 + Math.random() * 20)
      setLoadingProgress(0)
      const interval = setInterval(
        () => setLoadingProgress(prev => Math.min(prev + Math.floor(Math.random() * 5) + 1, dynamicMax)),
        400 + Math.random() * 600
      )
      return () => clearInterval(interval)
    } else {
      setLoadingProgress(100)
    }
  }, [showLoadingMessage])

  const handleErrorDialogClose = () => {
    toggleErrorDialog()
    setTimeout(() => setErrorMsg(null), 500)
  }

  useEffect(() => {
    setIsLoading(appStateContext?.state.chatHistoryLoadingState === ChatHistoryLoadingState.Loading)
  }, [appStateContext?.state.chatHistoryLoadingState])

  const getUserInfoList = async () => {
    if (!AUTH_ENABLED) { setShowAuthMessage(false); return }
    const userInfoList = await getUserInfo()
    if (userInfoList.length === 0 && window.location.hostname !== '127.0.0.1') {
      setShowAuthMessage(true)
    } else {
      setShowAuthMessage(false)
    }
  }

  let assistantMessage = {} as ChatMessage
  let toolMessage = {} as ChatMessage
  let assistantContent = ''

  const processResultMessage = (resultMessage: ChatMessage, userMessage: ChatMessage, conversationId?: string) => {
    if (resultMessage.role === ASSISTANT) {
      assistantContent += resultMessage.content
      assistantMessage = resultMessage
      assistantMessage.content = assistantContent
      assistantMessage.question = userMessage.content
      // Only use context as fallback if no real tool message was already set
      if (resultMessage.context && isEmpty(toolMessage)) {
        toolMessage = {
          id: uuid(),
          role: TOOL,
          content: JSON.stringify(resultMessage.context),
          date: new Date().toISOString()
        }
      }
    }
    if (resultMessage.role === TOOL) toolMessage = resultMessage

    if (!conversationId) {
      isEmpty(toolMessage)
        ? setMessages([...messages, userMessage, assistantMessage])
        : setMessages([...messages, userMessage, toolMessage, assistantMessage])
    } else {
      isEmpty(toolMessage)
        ? setMessages([...messages, assistantMessage])
        : setMessages([...messages, toolMessage, assistantMessage])
    }
  }

  const makeApiRequestWithoutHistory = async (question: string, conversationId?: string) => {
    setIsLoading(true)
    setShowLoadingMessage(true)
    const abortController = new AbortController()
    abortFuncs.current.unshift(abortController)

    const userMessage: ChatMessage = {
      id: uuid(), role: 'user', content: question, date: new Date().toISOString()
    }

    let conversation: Conversation | null | undefined
    if (!conversationId) {
      conversation = {
        id: conversationId ?? uuid(), title: question, messages: [userMessage], date: new Date().toISOString()
      }
    } else {
      conversation = appStateContext?.state?.currentChat
      if (!conversation) {
        setIsLoading(false); setShowLoadingMessage(false)
        abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
        return
      }
      conversation.messages.push(userMessage)
    }

    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
    setMessages(conversation.messages)

    const request: ConversationRequest = {
      messages: [...conversation.messages.filter(answer => answer.role !== ERROR)]
    }

    let result = {} as ChatResponse
    try {
      const response = await conversationApi(request, abortController.signal)
      if (response?.body) {
        const reader = response.body.getReader()
        let runningText = ''
        while (true) {
          setProcessMessages(messageStatus.Processing)
          const { done, value } = await reader.read()
          if (done) break
          const text = new TextDecoder('utf-8').decode(value)
          const objects = text.split('\n')
          objects.forEach(obj => {
            try {
              if (obj !== '' && obj !== '{}') {
                runningText += obj
                result = JSON.parse(runningText)
                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach(msg => {
                    msg.id = result.id
                    msg.date = new Date().toISOString()
                  })
                  if (result.choices[0].messages?.some(m => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false)
                  }
                  result.choices[0].messages.forEach(resultObj => {
                    processResultMessage(resultObj, userMessage, conversationId)
                  })
                } else if (result.error) {
                  throw Error(result.error)
                }
                runningText = ''
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) { console.error(e); throw e }
            }
          })
        }
        conversation.messages.push(toolMessage, assistantMessage)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, toolMessage, assistantMessage])
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        let errorMessage = 'An error occurred. Please try again.'
        if (result.error?.message) errorMessage = result.error.message
        else if (typeof result.error === 'string') errorMessage = result.error
        errorMessage = parseErrorMessage(errorMessage)
        const errorChatMsg: ChatMessage = {
          id: uuid(), role: ERROR, content: errorMessage, date: new Date().toISOString()
        }
        conversation.messages.push(errorChatMsg)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, errorChatMsg])
      } else {
        setMessages([...messages, userMessage])
      }
    } finally {
      setIsLoading(false); setShowLoadingMessage(false)
      abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
      setProcessMessages(messageStatus.Done)
    }
    return abortController.abort()
  }

  const makeApiRequestWithHistory = async (question: string, conversationId?: string) => {
    setIsLoading(true)
    setShowLoadingMessage(true)
    const abortController = new AbortController()
    abortFuncs.current.unshift(abortController)

    const userMessage: ChatMessage = {
      id: uuid(), role: 'user', content: question, date: new Date().toISOString()
    }

    let request: ConversationRequest
    let conversation
    if (conversationId) {
      conversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
      if (!conversation) {
        setIsLoading(false); setShowLoadingMessage(false)
        abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
        return
      }
      conversation.messages.push(userMessage)
      request = { messages: [...conversation.messages.filter(answer => answer.role !== ERROR)] }
    } else {
      request = { messages: [userMessage].filter(answer => answer.role !== ERROR) }
      setMessages(request.messages)
    }

    let result = {} as ChatResponse
    const errorResponseMessage = 'Please try again. If the problem persists, please contact the site administrator.'
    try {
      const response = conversationId
        ? await historyGenerate(request, abortController.signal, conversationId)
        : await historyGenerate(request, abortController.signal)

      if (!response?.ok) {
        const responseJson = await response.json()
        const errMsg = responseJson.error ?? errorResponseMessage
        const errorChatMsg: ChatMessage = {
          id: uuid(), role: ERROR,
          content: `There was an error generating a response. ${parseErrorMessage(errMsg)}`,
          date: new Date().toISOString()
        }
        if (conversationId) {
          const resultConv = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (resultConv) {
            resultConv.messages.push(errorChatMsg)
            appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConv })
            setMessages([...resultConv.messages])
          }
        } else {
          setMessages([...messages, userMessage, errorChatMsg])
        }
        return
      }

      if (response?.body) {
        const reader = response.body.getReader()
        let runningText = ''
        while (true) {
          setProcessMessages(messageStatus.Processing)
          const { done, value } = await reader.read()
          if (done) break
          const text = new TextDecoder('utf-8').decode(value)
          const objects = text.split('\n')
          objects.forEach(obj => {
            try {
              if (obj !== '' && obj !== '{}') {
                runningText += obj
                result = JSON.parse(runningText)
                if (!result.choices?.[0]?.messages?.[0].content) throw Error()
                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach(msg => {
                    msg.id = result.id
                    msg.date = new Date().toISOString()
                  })
                  if (result.choices[0].messages?.some(m => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false)
                  }
                  result.choices[0].messages.forEach(resultObj => {
                    processResultMessage(resultObj, userMessage, conversationId)
                  })
                }
                runningText = ''
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) { console.error(e); throw e }
            }
          })
        }

        let resultConversation
        if (conversationId) {
          resultConversation = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (!resultConversation) return
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage)
        } else {
          resultConversation = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage],
            date: result.history_metadata.date
          }
          isEmpty(toolMessage)
            ? resultConversation.messages.push(assistantMessage)
            : resultConversation.messages.push(toolMessage, assistantMessage)
        }
        if (!resultConversation) return
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConversation })
        isEmpty(toolMessage)
          ? setMessages([...messages, assistantMessage])
          : setMessages([...messages, toolMessage, assistantMessage])
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        let errorMessage = `An error occurred. ${errorResponseMessage}`
        if (result.error?.message) errorMessage = result.error.message
        else if (typeof result.error === 'string') errorMessage = result.error
        errorMessage = parseErrorMessage(errorMessage)
        const errorChatMsg: ChatMessage = {
          id: uuid(), role: ERROR, content: errorMessage, date: new Date().toISOString()
        }
        if (conversationId) {
          const resultConv = appStateContext?.state?.chatHistory?.find(conv => conv.id === conversationId)
          if (resultConv) {
            resultConv.messages.push(errorChatMsg)
            appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConv })
            setMessages([...messages, errorChatMsg])
          }
        } else {
          if (!result.history_metadata) {
            setMessages([...messages, userMessage, errorChatMsg])
            return
          }
          const resultConv = {
            id: result.history_metadata.conversation_id,
            title: result.history_metadata.title,
            messages: [userMessage, errorChatMsg],
            date: result.history_metadata.date
          }
          appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: resultConv })
          setMessages([...messages, errorChatMsg])
        }
      } else {
        setMessages([...messages, userMessage])
      }
    } finally {
      setIsLoading(false); setShowLoadingMessage(false)
      abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
      setProcessMessages(messageStatus.Done)
    }
    return abortController.abort()
  }

  const clearChat = async () => {
    setClearingChat(true)
    if (appStateContext?.state.currentChat?.id && appStateContext?.state.isHistoryAvailable.foundry) {
      const response = await historyClear(appStateContext.state.currentChat.id)
      if (!response.ok) {
        setErrorMsg({ title: 'Error clearing current chat', subtitle: 'Please try again.' })
        toggleErrorDialog()
      } else {
        appStateContext.dispatch({ type: 'DELETE_CURRENT_CHAT_MESSAGES', payload: appStateContext.state.currentChat.id })
        appStateContext.dispatch({ type: 'UPDATE_CHAT_HISTORY', payload: appStateContext.state.currentChat })
        setActiveCitation(undefined)
        appStateContext.dispatch({ type: 'CLOSE_ALL_CITATION_PANELS' })
        setMessages([])
      }
    }
    setClearingChat(false)
  }

  const getHighlightedContent = () => {
    if (!activeCitation) return ''
    let formattedContent = activeCitation.content.replace(
      /\[\d{2}:\d{2}:\d{2}\]/g,
      match => `\n\n**${match}**`
    )
    return formattedContent
  }

  const parseErrorMessage = (errorMessage: string) => {
    try {
      const match = errorMessage.match(/'innererror': ({.*})\}\}/)
      if (match) {
        const fixedJson = match[1].replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false')
        const innerErrorJson = JSON.parse(fixedJson)
        if (innerErrorJson.content_filter_result?.jailbreak?.filtered === true) {
          return 'The prompt was filtered due to triggering content filtering. Please modify your prompt.'
        }
      }
    } catch {}
    return errorMessage
  }

  const newChat = () => {
    setProcessMessages(messageStatus.Processing)
    setMessages([])
    appStateContext?.dispatch({ type: 'CLOSE_ALL_CITATION_PANELS' })
    setActiveCitation(undefined)
    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: null })
    setProcessMessages(messageStatus.Done)
  }

  const stopGenerating = () => {
    abortFuncs.current.forEach(a => a.abort())
    setShowLoadingMessage(false)
    setIsLoading(false)
  }

  useEffect(() => {
    if (appStateContext?.state.currentChat) {
      setMessages(appStateContext.state.currentChat.messages)
    } else {
      setMessages([])
    }
  }, [appStateContext?.state.currentChat])

  useLayoutEffect(() => {
    const saveToDB = async (messages: ChatMessage[], id: string) => {
      return await historyUpdate(messages, id)
    }
    if (appStateContext && appStateContext.state.currentChat && processMessages === messageStatus.Done) {
      if (appStateContext.state.isHistoryAvailable.foundry) {
        if (!appStateContext.state.currentChat?.messages) return
        const noContentError = appStateContext.state.currentChat.messages.find(m => m.role === ERROR)
        if (!noContentError?.content.includes(NO_CONTENT_ERROR)) {
          saveToDB(appStateContext.state.currentChat.messages, appStateContext.state.currentChat.id)
        }
      }
      appStateContext.dispatch({ type: 'UPDATE_CHAT_HISTORY', payload: appStateContext.state.currentChat })
      setMessages(appStateContext.state.currentChat.messages)
      setProcessMessages(messageStatus.NotRunning)
    }
  }, [processMessages])

  useEffect(() => {
    if (AUTH_ENABLED !== undefined) getUserInfoList()
  }, [AUTH_ENABLED])

  useLayoutEffect(() => {
    chatMessageStreamEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [showLoadingMessage, processMessages])

  const onShowCitation = (citation: Citation) => {
    setActiveCitation(citation)
    if (appStateContext) {
      appStateContext.dispatch({ type: 'OPEN_CHAT_CITATION_PANEL', payload: true })
      appStateContext.dispatch({ type: 'OPEN_ANSWER_CITATION_PANEL', payload: false })
    }
  }

  const parseToolMessageContent = (message: ChatMessage) => {
    if (message?.role === 'tool') {
      try {
        const parsed = typeof message.content === 'string' ? JSON.parse(message.content) : message.content
        return {
          citations: Array.isArray(parsed?.citations) ? parsed.citations : [],
          tool_calls: Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : [],
          documents: Array.isArray(parsed?.documents) ? parsed.documents : [],
        }
      } catch {}
    }
    return { citations: [], tool_calls: [], documents: [] }
  }

  const disabledButton = () => {
    return isLoading || (messages && messages.length === 0) || clearingChat ||
      appStateContext?.state.chatHistoryLoadingState === ChatHistoryLoadingState.Loading
  }

  const getAnswerProps = (index: number) => {
    const answerMessage = messages[index]
    const toolContent = parseToolMessageContent(messages[index - 1])
    return {
      answer: answerMessage.content,
      question: answerMessage.question ?? '',
      citations: toolContent.citations,
      tool_calls: toolContent.tool_calls,
      documents: toolContent.documents,
      plotly_data: null,
      message_id: answerMessage.id,
      feedback: answerMessage.feedback,
      IndexValue: index
    }
  }

  return (
    <div className={styles.container} role="main">
      {showAuthMessage ? (
        <Stack className={styles.chatEmptyState}>
          <ShieldLockRegular style={{ color: 'darkorange', height: '200px', width: '200px' }} />
          <h1 className={styles.chatEmptyStateTitle}>Authentication Not Configured</h1>
          <h2 className={styles.chatEmptyStateSubtitle}>
            This app does not have authentication configured. Please add an identity provider.
          </h2>
        </Stack>
      ) : (
        <Stack horizontal horizontalAlign="space-between" className={styles.chatRoot}>
          <Stack className={styles.chatEmptyState}>
            <h1 className={styles.chatEmptyStateTitle}>{ui?.chat_title}</h1>
            <div className={styles.chatEmptyStateSubtitle}>
              <ul className={styles.descriptionList}>
                {ui?.chat_description.map((item: any, i: number) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          </Stack>
          <Stack className={styles.chatContainer}>
            <div className={styles.chatMessageStream} style={{ marginBottom: isLoading ? '40px' : '0px' }} role="log">
              {messages.map((answer, index) => (
                <div key={index}>
                  {answer.role === 'user' ? (
                    <div className={styles.chatMessageUser} tabIndex={0}>
                      <div className={styles.chatMessageUserMessage}>{answer.content}</div>
                    </div>
                  ) : answer.role === 'assistant' ? (
                    <div className={styles.chatMessageGpt}>
                      <Answer answer={getAnswerProps(index)} onCitationClicked={c => onShowCitation(c)} />
                    </div>
                  ) : answer.role === ERROR ? (
                    <div className={styles.chatMessageError}>
                      <Stack horizontal className={styles.chatMessageErrorContent}>
                        <ErrorCircleRegular style={{ color: 'rgba(182, 52, 67, 1)' }} />
                        <span>Error</span>
                      </Stack>
                      <span className={styles.chatMessageErrorContent}>{answer.content}</span>
                    </div>
                  ) : null}
                </div>
              ))}
              {showLoadingMessage && (
                <>
                  <div style={{
                    position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
                    backgroundColor: 'rgba(255, 255, 255, 0.7)', display: 'flex', flexDirection: 'column',
                    justifyContent: 'center', alignItems: 'center', zIndex: 9999
                  }}>
                    <Spinner label={`AI is generating a response... ${loadingProgress}%`} size={SpinnerSize.large} />
                    <div style={{ marginTop: '10px', fontWeight: 'bold' }}>{loadingProgress}%</div>
                    <Stack horizontal className={styles.stopGeneratingContainer}
                      role="button" tabIndex={0} onClick={stopGenerating}
                      onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? stopGenerating() : null)}>
                      <SquareRegular className={styles.stopGeneratingIcon} aria-hidden="true" />
                      <span className={styles.stopGeneratingText} aria-hidden="true">Stop generating</span>
                    </Stack>
                  </div>
                  <div className={styles.chatMessageGpt}>
                    <Answer
                      answer={{ answer: '<strong>AI is generating a response....</strong>', citations: [], plotly_data: null, IndexValue: -1 }}
                      onCitationClicked={() => null}
                    />
                  </div>
                </>
              )}
              <div ref={chatMessageStreamEnd} />
            </div>

            <Stack horizontal className={styles.chatInput}>
              <Stack>
                {appStateContext?.state.isHistoryAvailable?.status !== HistoryStatus.NotConfigured && (
                  <CommandBarButton
                    role="button"
                    styles={{
                      icon: { color: '#FFFFFF' },
                      iconDisabled: { color: '#BDBDBD !important' },
                      root: {
                        color: '#FFFFFF',
                        background: 'radial-gradient(109.81% 107.82% at 100.1% 90.19%, #adc4d8ff 33.63%, #2D87C3 70.31%, #8DDDD8 100%)'
                      },
                      rootDisabled: { background: '#F0F0F0' }
                    }}
                    className={styles.newChatIcon}
                    iconProps={{ iconName: 'AddFilled' }}
                    onClick={newChat}
                    disabled={disabledButton()}
                    text="New Chat"
                    aria-label="start a new chat button"
                  />
                )}
                <Dialog hidden={hideErrorDialog} onDismiss={handleErrorDialogClose}
                  dialogContentProps={errorDialogContentProps} modalProps={modalProps} />
              </Stack>
              <QuestionInput
                clearOnSend
                placeholder="Type a new question..."
                disabled={isLoading}
                onSend={(question, id) => {
                  appStateContext?.state.isHistoryAvailable?.foundry
                    ? makeApiRequestWithHistory(question, id)
                    : makeApiRequestWithoutHistory(question, id)
                }}
                conversationId={appStateContext?.state.currentChat?.id}
              />
            </Stack>
          </Stack>

          {/* Citation Panel */}
          {messages && messages.length > 0 && isCitationPanelOpen && activeCitation && (
            <Stack.Item className={styles.citationPanel} tabIndex={0} role="tabpanel" aria-label="Citations Panel">
              <Stack horizontal className={styles.citationPanelHeaderContainer}
                horizontalAlign="space-between" verticalAlign="center">
                <span className={styles.citationPanelHeader}>Citations</span>
                <IconButton
                  iconProps={{ iconName: 'Cancel' }}
                  aria-label="Close citations panel"
                  onClick={() => appStateContext?.dispatch({ type: 'CLOSE_ALL_CITATION_PANELS' })}
                />
              </Stack>

              {/* Metadata tags */}
              {activeCitation.metadata && (
                <div className={styles.citationMetadata}>
                  {activeCitation.metadata.split(' | ').map((item, i) => (
                    <span key={i} className={styles.metadataTag}>{item}</span>
                  ))}
                </div>
              )}

              <h5 className={styles.citationPanelTitle} tabIndex={0}>
                {activeCitation.title}
              </h5>
              <div tabIndex={0}>
                <ReactMarkdown
                  linkTarget="_blank"
                  className={styles.citationPanelContent}
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeRaw]}>
                  {DOMPurify.sanitize(getHighlightedContent())}
                </ReactMarkdown>
              </div>
            </Stack.Item>
          )}

          {appStateContext?.state.isChatHistoryOpen &&
            appStateContext?.state.isHistoryAvailable?.status !== HistoryStatus.NotConfigured && <ChatHistoryPanel />}
        </Stack>
      )}
    </div>
  )
}

export default Chat
