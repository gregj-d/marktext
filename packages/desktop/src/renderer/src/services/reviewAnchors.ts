import type { ReviewComment } from '@shared/types/review'
import { diffChars } from 'diff'

interface TextSegment {
  node: Text
  start: number
  source: number
}

export interface ReviewTextIndex {
  text: string
  segments: TextSegment[]
}

/** Ignore Muya's syntax markers even while the caret makes them visible. */
export function indexReviewText(root: HTMLElement, markdown: string): ReviewTextIndex {
  const segments: TextSegment[] = []
  let text = ''
  let sourceCursor = 0
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (!node.data || node.parentElement?.closest(
      '.mu-remove, .mu-hide, .mu-front-button, .mu-preview, .CodeMirror-linenumber, [aria-hidden="true"]'
    )) continue
    const source = markdown.indexOf(node.data, sourceCursor)
    if (source < 0) continue
    const gap = markdown.slice(sourceCursor, source)
    const newlines = gap.match(/\n/g)?.length ?? 0
    if (text && newlines) text += '\n'.repeat(newlines)
    segments.push({ node, start: text.length, source })
    text += node.data
    sourceCursor = source + node.length
  }
  return { text, segments }
}

function boundary(index: ReviewTextIndex, offset: number, end: boolean): [Text, number] | null {
  for (const segment of index.segments) {
    const length = segment.node.length
    if (offset >= segment.start && offset <= segment.start + length) {
      if (!end && offset === segment.start + length) continue
      return [segment.node, offset - segment.start]
    }
  }
  return null
}

export function rangeInReviewIndex(index: ReviewTextIndex, start: number, end: number): Range | null {
  const from = boundary(index, start, false)
  const to = boundary(index, end, true)
  if (!from || !to) return null
  const range = document.createRange()
  range.setStart(...from)
  range.setEnd(...to)
  return range
}

const sourceBoundary = (index: ReviewTextIndex, offset: number, end = false): number | null => {
  const point = boundary(index, offset, end)
  if (!point) return null
  const segment = index.segments.find(item => item.node === point[0])
  return segment ? segment.source + point[1] : null
}

export interface ReviewSourceSpan { start: number; end: number }

export function sourceSpanForRange(index: ReviewTextIndex, range: Range): ReviewSourceSpan | null {
  const from = index.segments.find(segment => segment.node === range.startContainer)
  const to = index.segments.find(segment => segment.node === range.endContainer)
  return from && to
    ? { start: from.source + range.startOffset, end: to.source + range.endOffset }
    : null
}

/** Edits inside the protected span detach it; edits outside only move it. */
export function moveReviewSpan(
  before: string,
  after: string,
  span: ReviewSourceSpan
): ReviewSourceSpan | null {
  if (before === after) return span
  let cursor = 0
  let startShift = 0
  let endShift = 0
  for (const change of diffChars(before, after)) {
    const length = change.value.length
    if (change.added) {
      if (cursor > span.start && cursor < span.end) return null
      if (cursor <= span.start) startShift += length
      if (cursor < span.end) endShift += length
    } else if (change.removed) {
      if (cursor < span.end && cursor + length > span.start) return null
      if (cursor + length <= span.start) startShift -= length
      if (cursor + length <= span.end) endShift -= length
      cursor += length
    } else {
      cursor += length
    }
  }
  return { start: span.start + startShift, end: span.end + endShift }
}

export function rangeForSourceSpan(
  index: ReviewTextIndex,
  span: ReviewSourceSpan,
  quote: string
): Range | null {
  const from = index.segments.find(segment => span.start >= segment.source && span.start < segment.source + segment.node.length)
  const to = index.segments.find(segment => span.end > segment.source && span.end <= segment.source + segment.node.length)
  if (!from || !to) return null
  const start = from.start + span.start - from.source
  const end = to.start + span.end - to.source
  if (index.text.slice(start, end) !== quote) return null
  return rangeInReviewIndex(index, start, end)
}

export function commentFromRange(
  index: ReviewTextIndex,
  markdown: string,
  range: Range
): ReviewComment | null {
  let start: number | undefined
  let end = 0
  for (const segment of index.segments) {
    if (!range.intersectsNode(segment.node)) continue
    const from = range.startContainer === segment.node ? range.startOffset : 0
    const to = range.endContainer === segment.node ? range.endOffset : segment.node.length
    if (to <= from) continue
    start ??= segment.start + from
    end = segment.start + to
  }
  if (start === undefined || end <= start) return null
  const from = sourceBoundary(index, start)
  const to = sourceBoundary(index, end, true)
  if (from === null || to === null) return null
  return {
    quote: index.text.slice(start, end),
    prefix: markdown.slice(Math.max(0, from - 40), from),
    suffix: markdown.slice(to, to + 40),
    line: markdown.slice(0, from).split('\n').length,
    text: ''
  }
}

/** A surviving quote alone is not enough when its original context has disappeared. */
export function resolveReviewRange(
  index: ReviewTextIndex,
  markdown: string,
  comment: ReviewComment
): Range | null {
  if (!comment.quote) return null
  const matches: Array<{ start: number; score: number }> = []
  let cursor = 0
  while (cursor <= index.text.length) {
    const start = index.text.indexOf(comment.quote, cursor)
    if (start < 0) break
    const end = start + comment.quote.length
    const from = sourceBoundary(index, start)
    const to = sourceBoundary(index, end, true)
    if (from !== null && to !== null) {
      const before = markdown.slice(Math.max(0, from - comment.prefix.length), from)
      const after = markdown.slice(to, to + comment.suffix.length)
      const prefix = !!comment.prefix && before === comment.prefix
      const suffix = !!comment.suffix && after === comment.suffix
      const score = Number(prefix) + Number(suffix)
      if ((!comment.prefix || prefix) && (!comment.suffix || suffix)) {
        matches.push({ start, score })
      }
    }
    cursor = start + Math.max(comment.quote.length, 1)
  }
  matches.sort((a, b) => b.score - a.score)
  if (!matches.length || (matches[1] && matches[1].score === matches[0].score)) return null
  return rangeInReviewIndex(index, matches[0].start, matches[0].start + comment.quote.length)
}
