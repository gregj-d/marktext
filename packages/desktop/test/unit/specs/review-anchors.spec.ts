import { beforeEach, describe, expect, it } from 'vitest'
import { commentFromRange, indexReviewText, moveReviewSpan, resolveReviewRange } from '@/services/reviewAnchors'
import { isOwnReviewWrite, recordReviewWrite, reviewSessions } from 'main_renderer/reviewSessions'

function root(html: string): HTMLDivElement {
  const element = document.createElement('div')
  element.innerHTML = html
  return element
}

function fixture<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing fixture value')
  return value
}

describe('rendered review anchors', () => {
  it('moves the protected source span for outside edits but detaches it for inside edits', () => {
    expect(moveReviewSpan('a target z', 'before a target z', { start: 2, end: 8 })).toEqual({ start: 9, end: 15 })
    expect(moveReviewSpan('a target z', 'a target z after', { start: 2, end: 8 })).toEqual({ start: 2, end: 8 })
    expect(moveReviewSpan('a target z', 'a targXet z', { start: 2, end: 8 })).toBeNull()
    expect(moveReviewSpan('first target\nsecond target', 'first target\n', { start: 20, end: 26 })).toBeNull()
  })
  it('anchors across emphasis without changing editor DOM or markdown', () => {
    const markdown = 'Before **bold** and *italic* after.\n'
    const element = root('<p>Before <span class="mu-remove">**</span><strong>bold</strong><span class="mu-remove">**</span> and <span class="mu-remove">*</span><em>italic</em><span class="mu-remove">*</span> after.</p>')
    const before = element.innerHTML
    const range = document.createRange()
    range.setStart(fixture(fixture(element.querySelector('strong')).firstChild), 0)
    range.setEnd(fixture(fixture(element.querySelector('em')).firstChild), 6)
    const index = indexReviewText(element, markdown)
    const comment = fixture(commentFromRange(index, markdown, range))
    expect(comment.quote).toBe('bold and italic')
    expect(comment.prefix).toBe('Before **')
    expect(comment.suffix).toBe('* after.\n')
    expect(resolveReviewRange(index, markdown, comment)?.startContainer).toBe(range.startContainer)
    expect(resolveReviewRange(index, markdown, comment)?.endContainer).toBe(range.endContainer)
    expect(element.innerHTML).toBe(before)
  })

  it('uses source context to pick the selected repeated phrase', () => {
    const markdown = 'First target here.\n\nSecond target there.\n'
    const element = root('<p>First target here.</p><p>Second target there.</p>')
    const node = fixture(fixture(element.lastElementChild).firstChild)
    const range = document.createRange()
    range.setStart(node, 7)
    range.setEnd(node, 13)
    const index = indexReviewText(element, markdown)
    const comment = fixture(commentFromRange(index, markdown, range))
    expect(comment.quote).toBe('target')
    expect(comment.line).toBe(3)
    expect(resolveReviewRange(index, markdown, comment)?.startContainer).toBe(node)
  })

  it('detaches rather than guessing when context is gone or a quote is ambiguous', () => {
    const index = indexReviewText(root('<p>target unrelated.</p>'), 'target unrelated.\n')
    const comment = { quote: 'target', prefix: 'Original preceding context ', suffix: '\n', line: 2, text: '' }
    expect(resolveReviewRange(index, 'target unrelated.\n', comment)).toBeNull()
    const repeated = indexReviewText(root('<p>target target</p>'), 'target target')
    expect(resolveReviewRange(repeated, 'target target', { ...comment, prefix: '', suffix: '' })).toBeNull()
  })
})

describe('review own-save fingerprint', () => {
  beforeEach(() => reviewSessions.clear())
  it('distinguishes byte-identical save events from immediate agent edits', () => {
    reviewSessions.set('r_1_abcdef', {
      pathname: '/review/session.json',
      session: {
        id: 'r_1_abcdef', file: '/track/doc.md', track_root: '/track',
        thread: '', track_id: '', bridge: 'http://127.0.0.1:1', created_at: ''
      }
    })
    recordReviewWrite('/track/doc.md', Buffer.from('user\r\n'))
    expect(isOwnReviewWrite('/track/doc.md', Buffer.from('user\r\n'))).toBe(true)
    expect(isOwnReviewWrite('/track/doc.md', Buffer.from('agent\r\n'))).toBe(false)
    expect(isOwnReviewWrite('/track/doc.md', Buffer.from('user\n'))).toBe(false)
    expect(isOwnReviewWrite('/track/other.md', Buffer.from('user\r\n'))).toBe(false)
  })
})
