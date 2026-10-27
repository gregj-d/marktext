export interface ReviewSession {
  id: string
  file: string
  thread: string
  track_id: string
  track_root: string
  bridge: string
  created_at: string
}

export interface ReviewComment {
  quote: string
  prefix: string
  suffix: string
  line: number
  text: string
}

export interface ReviewDraft {
  baseline?: string
  comments: ReviewComment[]
  note: string
  round: number
}

export interface ReviewAttachment {
  session: ReviewSession
  draft: ReviewDraft
  baseline: string
}

export interface ReviewSendRequest extends ReviewDraft {
  id: string
  baseline: string
}

export interface ReviewPayload extends ReviewDraft {
  id: string
  diff: string
}

export interface ReviewResult {
  round: number
  delivered: boolean
  error?: string
}

export interface ReviewSendResult {
  result: ReviewResult
  saved: string
}
