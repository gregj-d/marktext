import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import { buildReviewPayload } from 'common/review'
import { reviewSessions as sessions } from './reviewSessions'
import type {
  ReviewAttachment,
  ReviewDraft,
  ReviewResult,
  ReviewSendRequest,
  ReviewSession
} from '@shared/types/review'

const draftWrites = new Map<string, Promise<void>>()
const sending = new Set<string>()

const readSession = (pathname: string): ReviewSession => {
  const session = JSON.parse(fs.readFileSync(pathname, 'utf8')) as ReviewSession
  if (
    !/^r_\d+_[a-f0-9]{6}$/.test(session.id) ||
    !path.isAbsolute(session.file) ||
    !path.isAbsolute(session.track_root)
  ) throw new Error('Invalid review session')
  const relpath = path.relative(fs.realpathSync(session.track_root), fs.realpathSync(session.file))
  if (!relpath || relpath.startsWith('..') || path.isAbsolute(relpath)) {
    throw new Error('Review file must be inside its track')
  }
  const bridge = new URL(session.bridge)
  if (bridge.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(bridge.hostname)) {
    throw new Error('Review bridge must be a local HTTP endpoint')
  }
  return session
}

export const registerReviewSession = (pathname: string): string => {
  const session = readSession(pathname)
  sessions.set(session.id, { ...sessions.get(session.id), pathname, session })
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('mt::review-sessions-changed')
  }
  return session.file
}

const getEntry = (id: string) => {
  const entry = sessions.get(id)
  if (!entry) throw new Error('Unknown review session')
  return entry
}

const draftPath = (id: string): string => path.join(path.dirname(getEntry(id).pathname), 'draft.json')

const saveDraft = (id: string, draft: ReviewDraft): Promise<void> => {
  const previous = draftWrites.get(id) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(() =>
    writeFileAtomic(draftPath(id), JSON.stringify(draft, null, 2) + '\n', { encoding: 'utf8' })
  )
  draftWrites.set(id, write)
  return write
}

export const registerReviewIpc = (): void => {
  ipcMain.handle('mt::review-attach', async(_event, file: string): Promise<ReviewAttachment | null> => {
    const entry = [...sessions.values()].find(({ session }) => session.file === file)
    if (!entry) return null
    await draftWrites.get(entry.session.id)
    let draft: ReviewDraft = { comments: [], note: '', round: 1 }
    const pathname = draftPath(entry.session.id)
    if (fs.existsSync(pathname)) {
      const value = JSON.parse(await fs.promises.readFile(pathname, 'utf8')) as Partial<ReviewDraft>
      draft = {
        ...(typeof value.baseline === 'string' ? { baseline: value.baseline } : {}),
        comments: Array.isArray(value.comments) ? value.comments : [],
        note: typeof value.note === 'string' ? value.note : '',
        round: typeof value.round === 'number' && Number.isInteger(value.round) && value.round > 0 ? value.round : 1
      }
    }
    return {
      session: entry.session,
      draft,
      baseline: draft.baseline ?? await fs.promises.readFile(file, 'utf8')
    }
  })
  ipcMain.handle('mt::review-draft', (_event, id: string, draft: ReviewDraft) => saveDraft(id, draft))
  ipcMain.handle('mt::review-send', async(_event, request: ReviewSendRequest) => {
    if (sending.has(request.id)) throw new Error('Review is already being sent')
    sending.add(request.id)
    try {
      const entry = getEntry(request.id)
      // Track bridges can restart on a different port while the editor stays open.
      const session = readSession(entry.pathname)
      if (session.id !== request.id || session.file !== entry.session.file) {
        throw new Error('Review session changed; reopen the review')
      }
      const saved = await fs.promises.readFile(session.file, 'utf8')
      const relpath = path.relative(session.track_root, session.file).split(path.sep).join('/')
      const payload = buildReviewPayload(request, relpath, saved)
      const response = await fetch(new URL('/review/send', session.bridge), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000)
      })
      if (!response.ok) throw new Error(`Bridge returned ${response.status}: ${await response.text()}`)
      const result = await response.json() as ReviewResult
      if (result.round !== request.round || typeof result.delivered !== 'boolean') {
        throw new Error('Invalid bridge response')
      }
      await saveDraft(request.id, { comments: [], note: '', round: request.round + 1, baseline: saved })
      return { result, saved }
    } finally {
      sending.delete(request.id)
    }
  })
}
