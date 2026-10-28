export interface ReviewSession {
  id: string
  file: string
  thread: string
  track_id: string
  track_root: string
  bridge: string
  created_at: string
}

export interface ReviewMessage {
  id: string
  role: 'user' | 'agent'
  text: string
  created_at: string
  reply_to?: string
  outcome?: 'addressed' | 'blocked' | 'question'
}
export interface ReviewThread {
  id: string
  quote: string
  prefix: string
  suffix: string
  line: number
  status: 'open' | 'resolved'
  messages: ReviewMessage[]
}
export interface ReviewBatch {
  round: number
  note: string
  note_id: string
  comment_message_ids: string[]
  inline_message_ids: string[]
  messages: ReviewMessage[]
}
export interface ReviewSubmission {
  id: string
  mode: 'inline' | 'batch'
  round?: number
  thread_id?: string
  message_ids: string[]
  delivered: boolean
  error?: string
  created_at: string
}
export interface ReviewConversation {
  version: 1
  id: string
  revision: number
  threads: ReviewThread[]
  rounds: ReviewBatch[]
  submissions: ReviewSubmission[]
}

export interface ReviewComment {
  id?: string
  message_id?: string
  ready?: boolean
  resolved?: boolean
  submitted?: boolean
  messages?: ReviewMessage[]
  quote: string
  prefix: string
  suffix: string
  line: number
  text: string
}

export interface ReviewDraft {
  pending?: ReviewSendRequest
  baseline?: string
  comments: ReviewComment[]
  note: string
  round: number
}

export interface ReviewAttachment {
  conversation?: ReviewConversation
  session: ReviewSession
  draft: ReviewDraft
  baseline: string
}

export interface ReviewSendRequest extends ReviewDraft {
  mode?: 'inline' | 'batch'
  submission_id?: string
  note_id?: string
  id: string
  baseline: string
}

export interface ReviewPayload extends ReviewDraft {
  submission_id?: string
  note_id?: string
  id: string
  diff: string
}

export interface ReviewResult {
  submission_id?: string
  round: number
  delivered: boolean
  error?: string
}

export interface ReviewSendResult {
  conversation?: ReviewConversation
  result: ReviewResult
  saved: string
}
