import type { Muya } from '@muyajs/core'
import type { ReviewComment } from '@shared/types/review'
import { anchorComment } from 'common/review'
import { commentFromRange, indexReviewText, resolveReviewRange } from './reviewAnchors'

let reviewEditor: Muya | null = null

export const registerReviewEditor = (editor: Muya | null): void => {
  reviewEditor = editor
}

interface SourceEditor {
  getSelection(): string
  getCursor(which: string): unknown
  indexFromPos(position: unknown): number
  hasFocus(): boolean
  getValue(): string
  cursorCoords(position: unknown, mode: string): { left: number; right: number; top: number; bottom: number }
}

export interface ReviewSelection {
  comment: ReviewComment
  rect: { left: number; right: number; top: number; bottom: number }
  range?: Range
}

export const reviewEditorRoot = (): HTMLElement | null => {
  if (document.querySelector('.source-code')) {
    return document.querySelector('.source-code .CodeMirror-code')
  }
  return document.querySelector('.editor-component .mu-container') ??
    document.querySelector('.editor-component')
}

export function captureReviewSelection(): ReviewSelection | null {
  const cm = (document.querySelector('.source-code .CodeMirror') as
    (Element & { CodeMirror?: SourceEditor }) | null)?.CodeMirror
  if (cm?.hasFocus() && cm.getSelection().trim()) {
    return {
      comment: anchorComment(cm.getValue(), cm.getSelection(), cm.indexFromPos(cm.getCursor('from'))),
      rect: cm.cursorCoords(cm.getCursor('to'), 'window')
    }
  }
  const selection = window.getSelection()
  const root = reviewEditorRoot()
  if (!selection?.rangeCount || selection.isCollapsed || !root) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const surface = root.closest('.editor-component') ?? root
  if (document.activeElement && document.activeElement !== document.body && !surface.contains(document.activeElement)) return null
  const markdown = reviewEditor?.getMarkdown()
  if (markdown === undefined) return null
  const comment = commentFromRange(indexReviewText(root, markdown), markdown, range) ?? {
    quote: selection.toString(), prefix: '', suffix: '', line: 0, text: ''
  }
  if (!comment?.quote.trim()) return null
  return { comment, range: range.cloneRange(), rect: range.getBoundingClientRect() }
}

export function selectReviewQuote(markdown: string, comment: ReviewComment): void {
  const root = reviewEditorRoot()
  if (!root) return
  const range = resolveReviewRange(indexReviewText(root, markdown), markdown, comment)
  if (!range) return
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
