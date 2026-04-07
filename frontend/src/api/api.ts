import {
  ChatMessage,
  Conversation,
  ConversationRequest,
  HistoryHealth,
  HistoryStatus,
  UserInfo
} from './models'

export async function conversationApi(options: ConversationRequest, abortSignal: AbortSignal): Promise<Response> {
  const response = await fetch('/conversation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: options.messages }),
    signal: abortSignal
  })
  return response
}

export async function getUserInfo(): Promise<UserInfo[]> {
  const response = await fetch('/.auth/me')
  if (!response.ok) {
    console.log('No identity provider found. Access to chat will be blocked.')
    return []
  }
  return await response.json()
}

export const historyList = async (offset = 0): Promise<Conversation[] | null> => {
  try {
    const response = await fetch(`/history/list?offset=${offset}`, { method: 'GET' })
    const payload = await response.json()
    if (!Array.isArray(payload)) return null

    const conversations: Conversation[] = await Promise.all(
      payload.map(async (conv: any) => {
        let convMessages: ChatMessage[] = []
        try {
          convMessages = await historyRead(conv.id)
        } catch (err) {
          console.error('error fetching messages: ', err)
        }
        return {
          id: conv.id,
          title: conv.title,
          date: conv.createdAt,
          messages: convMessages
        }
      })
    )
    return conversations
  } catch {
    console.error('There was an issue fetching your data.')
    return null
  }
}

export const historyRead = async (convId: string): Promise<ChatMessage[]> => {
  try {
    const response = await fetch('/history/read', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: convId }),
      headers: { 'Content-Type': 'application/json' }
    })
    if (!response) return []
    const payload = await response.json()
    const messages: ChatMessage[] = []
    if (payload?.messages) {
      payload.messages.forEach((msg: any) => {
        messages.push({
          id: msg.id,
          role: msg.role,
          date: msg.createdAt,
          content: msg.content,
          feedback: msg.feedback ?? undefined
        })
      })
    }
    return messages
  } catch {
    console.error('There was an issue fetching your data.')
    return []
  }
}

export const historyGenerate = async (
  options: ConversationRequest,
  abortSignal: AbortSignal,
  convId?: string
): Promise<Response> => {
  const body = convId
    ? JSON.stringify({ conversation_id: convId, messages: options.messages })
    : JSON.stringify({ messages: options.messages })

  try {
    return await fetch('/history/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: abortSignal
    })
  } catch {
    console.error('There was an issue fetching your data.')
    return new Response()
  }
}

export const historyUpdate = async (messages: ChatMessage[], convId: string): Promise<Response> => {
  try {
    return await fetch('/history/update', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: convId, messages }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}

export const historyDelete = async (convId: string): Promise<Response> => {
  try {
    return await fetch('/history/delete', {
      method: 'DELETE',
      body: JSON.stringify({ conversation_id: convId }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}

export const historyDeleteAll = async (): Promise<Response> => {
  try {
    return await fetch('/history/delete_all', {
      method: 'DELETE',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}

export const historyClear = async (convId: string): Promise<Response> => {
  try {
    return await fetch('/history/clear', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: convId }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}

export const historyRename = async (convId: string, title: string): Promise<Response> => {
  try {
    return await fetch('/history/rename', {
      method: 'POST',
      body: JSON.stringify({ conversation_id: convId, title }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}

export const historyEnsure = async (): Promise<HistoryHealth> => {
  try {
    const response = await fetch('/history/ensure', { method: 'GET' })
    const respJson = await response.json()
    let formattedResponse
    if (respJson.message) {
      formattedResponse = HistoryStatus.Working
    } else if (response.status === 500) {
      formattedResponse = HistoryStatus.NotWorking
    } else if (response.status === 401) {
      formattedResponse = HistoryStatus.InvalidCredentials
    } else if (response.status === 422) {
      formattedResponse = respJson.error
    } else {
      formattedResponse = HistoryStatus.NotConfigured
    }
    return {
      foundry: response.ok,
      status: formattedResponse
    }
  } catch (err) {
    return { foundry: false, status: err as string }
  }
}

export const frontendSettings = async (): Promise<Response | null> => {
  try {
    const response = await fetch('/frontend_settings', { method: 'GET' })
    return await response.json()
  } catch {
    console.error('There was an issue fetching your data.')
    return null
  }
}

export const historyMessageFeedback = async (messageId: string, feedback: string): Promise<Response> => {
  try {
    return await fetch('/history/message_feedback', {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId, message_feedback: feedback }),
      headers: { 'Content-Type': 'application/json' }
    })
  } catch {
    return { ...new Response(), ok: false, status: 500 } as Response
  }
}
