import type { ReviewComment } from '@shared/types/review'
import type { Muya } from '@muyajs/core'
import { findCommentOffset } from 'common/review'
import bus from '../bus'

let reviewEditor: Muya | null = null

export const registerReviewEditor = (editor: Muya | null): void => {
  reviewEditor = editor
}

const sourcePosition = (markdown: string, offset: number) => {
  const before = markdown.slice(0, offset)
  return { line: before.split('\n').length - 1, ch: offset - before.lastIndexOf('\n') - 1 }
}

interface SourceEditor {
  getSelection(): string
  getCursor(which: string): unknown
  indexFromPos(position: unknown): number
  posFromIndex(index: number): unknown
  setSelection(from: unknown, to: unknown): void
  focus(): void
}

const sourceEditor = (): SourceEditor | undefined => (
  document.querySelector('.source-code .CodeMirror') as (Element & { CodeMirror?: SourceEditor }) | null
)?.CodeMirror

export function captureReviewSelection(): { quote: string; offset?: number } {
  const cm = sourceEditor()
  if (cm?.getSelection()) {
    return { quote: cm.getSelection(), offset: cm.indexFromPos(cm.getCursor('from')) }
  }
  const selection = window.getSelection()
  const root = document.querySelector('.editor-component')
  if (selection?.anchorNode && root?.contains(selection.anchorNode)) {
    const quote = selection.toString()
    if (!quote) return { quote: '' }
    const cursor = reviewEditor?.getCursorOffset()
    const positions = [cursor?.anchor, cursor?.focus].filter(position => position != null)
    positions.sort((a, b) => a.line - b.line || a.ch - b.ch)
    const start = positions[0]
    const markdown = reviewEditor?.getMarkdown() ?? ''
    const offset = start
      ? markdown.split('\n').slice(0, start.line).reduce((sum, line) => sum + line.length + 1, 0) + start.ch
      : undefined
    return { quote, offset }
  }
  return { quote: '' }
}

export function selectReviewQuote(markdown: string, comment: ReviewComment): void {
  const offset = findCommentOffset(markdown, comment)
  const cm = sourceEditor()
  if (cm && offset >= 0) {
    cm.focus()
    cm.setSelection(cm.posFromIndex(offset), cm.posFromIndex(offset + comment.quote.length))
    return
  }
  if (reviewEditor && offset >= 0) {
    reviewEditor.domNode.focus()
    reviewEditor.setCursorByOffset({
      anchor: sourcePosition(markdown, offset),
      focus: sourcePosition(markdown, offset + comment.quote.length)
    })
    return
  }
  bus.emit('searchValue', { value: comment.quote, opt: { isCaseSensitive: true } })
}
