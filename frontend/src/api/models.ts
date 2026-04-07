export type ToolCallEntry = {
  iteration: number
  tool: string
  args: Record<string, any>
}

export type DocumentEntry = {
  iteration: number
  tool: string
  result: any
}

export type AskResponse = {
  answer: string
  citations: Citation[]
  plotly_data: null
  error?: string
  message_id?: string
  feedback?: Feedback
  IndexValue: number
  question?: string | null
  tool_calls?: ToolCallEntry[]
  documents?: DocumentEntry[]
}

export type Citation = {
  part_index?: number
  content: string
  id: string
  title: string | null
  filepath: string | null
  url: string | null
  metadata: string | null
  chunk_id: string | null
  reindex_id: string | null
  chunk_start_time?: string
  chunk_end_time?: string
  project_title?: string
  voc_title?: string
  tool_source?: string
  doc_type?: string
}

export type ToolMessageContent = {
  citations: Citation[]
  intent: string
  tool_calls?: any[]
  documents?: any[]
}

export type ChatMessage = {
  id: string
  role: string
  content: string
  end_turn?: boolean
  date: string
  feedback?: Feedback
  context?: string
  question?: string
}

export type Conversation = {
  id: string
  title: string
  messages: ChatMessage[]
  date: string
}

export enum ChatCompletionType {
  ChatCompletion = 'chat.completion',
  ChatCompletionChunk = 'chat.completion.chunk'
}

export type ChatResponseChoice = {
  messages: ChatMessage[]
}

export type ChatResponse = {
  id: string
  model: string
  created: number
  object: ChatCompletionType
  choices: ChatResponseChoice[]
  history_metadata: {
    conversation_id: string
    title: string
    date: string
  }
  error?: any
}

export type ConversationRequest = {
  messages: ChatMessage[]
}

export type UserInfo = {
  access_token: string
  expires_on: string
  id_token: string
  provider_name: string
  user_claims: any[]
  user_id: string
}

export enum HistoryStatus {
  NotConfigured = 'History is not configured',
  NotWorking = 'History is not working',
  InvalidCredentials = 'History has invalid credentials',
  InvalidDatabase = 'Invalid database name',
  InvalidContainer = 'Invalid container name',
  Working = 'Foundry history is configured and working'
}

export type HistoryHealth = {
  foundry: boolean
  status: string
}

export enum ChatHistoryLoadingState {
  Loading = 'loading',
  Success = 'success',
  Fail = 'fail',
  NotStarted = 'notStarted'
}

export type ErrorMessage = {
  title: string
  subtitle: string
}

export type UI = {
  title: string
  chat_title: string
  chat_description: string[]
  logo?: string
  chat_logo?: string
  show_share_button?: boolean
}

export type FrontendSettings = {
  auth_enabled?: string | null
  feedback_enabled?: string | null
  ui?: UI
  sanitize_answer?: boolean
}

export enum Feedback {
  Neutral = 'neutral',
  Positive = 'positive',
  Negative = 'negative',
  MissingCitation = 'missing_citation',
  WrongCitation = 'wrong_citation',
  OutOfScope = 'out_of_scope',
  InaccurateOrIrrelevant = 'inaccurate_or_irrelevant',
  OtherUnhelpful = 'other_unhelpful',
  HateSpeech = 'hate_speech',
  Violent = 'violent',
  Sexual = 'sexual',
  Manipulative = 'manipulative',
  OtherHarmful = 'other_harmlful'
}
