import { describe, expect, it } from 'vitest'
import { applyPatch } from 'diff'
import { anchorComment, buildReviewPayload, findCommentOffset } from 'common/review'
import parseArgs, { userArguments } from '../../../src/main/cli/parser'

describe('review payload', () => {
  const request = {
    id: 'r_123_abcdef',
    round: 2,
    baseline: '# Before\n',
    comments: [anchorComment('# Before\n', 'Before')],
    note: 'Please expand this.'
  }

  it('uses track-relative git headers and describes exactly the saved content', () => {
    const payload = buildReviewPayload(request, 'docs/plan.md', '# After\n')
    expect(payload.diff).toContain('--- a/docs/plan.md')
    expect(payload.diff).toContain('+++ b/docs/plan.md')
    expect(applyPatch(request.baseline, payload.diff)).toBe('# After\n')
    expect(payload).toMatchObject({
      id: request.id, round: 2, comments: request.comments, note: request.note
    })
    expect(payload).not.toHaveProperty('baseline')
  })
  it('includes stable delivery IDs without leaking local draft or conversation state', () => {
    const comment = { ...request.comments[0], id: 'c_one', message_id: 'm_one', ready: true, resolved: false, messages: [] }
    const payload = buildReviewPayload({ ...request, comments: [comment], submission_id: 's_one', note_id: 'n_one' }, 'plan.md', request.baseline)
    expect(payload).toMatchObject({ submission_id: 's_one', note_id: 'n_one', comments: [{ id: 'c_one', message_id: 'm_one' }] })
    expect(payload.comments[0]).not.toHaveProperty('messages')
    expect(payload.comments[0]).not.toHaveProperty('ready')
    expect(payload.comments[0]).not.toHaveProperty('resolved')
  })

  it('sends an empty diff for comments-only feedback', () => {
    expect(buildReviewPayload(request, 'plan.md', request.baseline).diff).toBe('')
  })
})

describe('comment anchoring', () => {
  it('captures source line and up to forty characters of surrounding context', () => {
    const markdown = `${'x'.repeat(60)}\nquoted words\n${'y'.repeat(60)}`
    const comment = anchorComment(markdown, 'quoted words')
    expect(comment).toEqual({
      quote: 'quoted words',
      prefix: 'x'.repeat(39) + '\n',
      suffix: '\n' + 'y'.repeat(39),
      line: 2,
      text: ''
    })
  })

  it('uses the source selection offset to disambiguate repeated quotes', () => {
    const markdown = 'first target\n\nsecond target\n'
    const comment = anchorComment(markdown, 'target', markdown.lastIndexOf('target'))
    expect(comment.line).toBe(3)
    expect(findCommentOffset(markdown, comment)).toBe(markdown.lastIndexOf('target'))
  })

  it('preserves rendered quotes absent from source with unknown line', () => {
    expect(anchorComment('**formatted** source', 'formatted source')).toEqual({
      quote: 'formatted source', prefix: '', suffix: '', line: 0, text: ''
    })
  })

  it('falls back to quote search after the surrounding text changes', () => {
    const comment = anchorComment('old quote context', 'quote')
    expect(findCommentOffset('new quote context', comment)).toBe(4)
    expect(findCommentOffset('quote removed', { ...comment, quote: 'missing' })).toBe(-1)
  })
})

describe('review launch arguments', () => {
  it('consumes the session flag without treating its value as a document', () => {
    const argv = ['/electron', '/app', '--sloptown-review', '/review/session.json', '/track/doc.md']
    const args = parseArgs(userArguments(argv, true, '/app'))
    expect(args['--sloptown-review']).toBe('/review/session.json')
    expect(args._).toEqual(['/track/doc.md'])
  })
})
