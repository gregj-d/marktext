import { createTwoFilesPatch } from 'diff'
import type { ReviewComment, ReviewPayload, ReviewSendRequest } from '@shared/types/review'

export const buildReviewPayload = (
  request: ReviewSendRequest,
  relpath: string,
  saved: string
): ReviewPayload => ({
  id: request.id,
  round: request.round,
  diff: request.baseline === saved
    ? ''
    : createTwoFilesPatch(`a/${relpath}`, `b/${relpath}`, request.baseline, saved),
  comments: request.comments,
  note: request.note
})

/** Prefer the occurrence nearest the source selection when a quote is repeated. */
export const anchorComment = (
  markdown: string,
  quote: string,
  offset?: number
): ReviewComment => {
  let index = -1
  let from = 0
  if (quote) {
    while (from <= markdown.length) {
      const candidate = markdown.indexOf(quote, from)
      if (candidate < 0) break
      if (index < 0 || Math.abs(candidate - (offset ?? 0)) < Math.abs(index - (offset ?? 0))) {
        index = candidate
      }
      from = candidate + Math.max(quote.length, 1)
    }
  }
  return {
    quote,
    prefix: index < 0 ? '' : markdown.slice(Math.max(0, index - 40), index),
    suffix: index < 0 ? '' : markdown.slice(index + quote.length, index + quote.length + 40),
    line: index < 0 ? 0 : markdown.slice(0, index).split('\n').length,
    text: ''
  }
}

export const findCommentOffset = (markdown: string, comment: ReviewComment): number => {
  if (!comment.quote) return -1
  const context = comment.prefix + comment.quote + comment.suffix
  const contextual = markdown.indexOf(context)
  if (contextual >= 0) return contextual + comment.prefix.length
  return markdown.indexOf(comment.quote)
}
