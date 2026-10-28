import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import chokidar from 'chokidar'
import { buildReviewPayload } from 'common/review'
import { reviewSessions as sessions } from './reviewSessions'
import type {
  ReviewAttachment,
  ReviewConversation,
  ReviewDraft,
  ReviewResult,
  ReviewSendRequest,
  ReviewSession
} from '@shared/types/review'

const draftWrites = new Map<string, Promise<void>>()
const sending = new Set<string>()
const conversationWatchers = new Map<string, () => void>()

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

const conversationPath = (id: string): string => {
  const { session } = getEntry(id)
  return path.join(session.track_root, '.agents', 'reviews', id, 'conversation.json')
}
const readConversation = async(id: string): Promise<ReviewConversation> => {
  try {
    const value = JSON.parse(await fs.promises.readFile(conversationPath(id), 'utf8')) as ReviewConversation
    if (value.id !== id || value.version !== 1 || !Array.isArray(value.threads) || !Array.isArray(value.rounds) || !Array.isArray(value.submissions)) {
      throw new Error('Invalid review conversation')
    }
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return { version: 1, id, revision: 0, threads: [], rounds: [], submissions: [] }
  }
}
const postReview = async(id: string, route: string, body: unknown): Promise<ReviewResult> => {
  const entry = getEntry(id)
  const session = readSession(entry.pathname)
  if (session.id !== id || session.file !== entry.session.file) throw new Error('Review session changed; reopen the review')
  const capability = await fetch(new URL(`/review/state?id=${encodeURIComponent(id)}`, session.bridge), { signal: AbortSignal.timeout(5000) })
  if (!capability.ok || (await capability.json() as ReviewConversation).version !== 1) {
    throw new Error('The review bridge needs updating. Reopen this track, then retry the send.')
  }
  const response = await fetch(new URL(route, session.bridge), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  })
  if (!response.ok) throw new Error(`Bridge returned ${response.status}: ${await response.text()}`)
  return await response.json() as ReviewResult
}

const saveDraft = (id: string, draft: ReviewDraft): Promise<void> => {
  const previous = draftWrites.get(id) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(() =>
    writeFileAtomic(draftPath(id), JSON.stringify(draft, null, 2) + '\n', { encoding: 'utf8' })
  )
  draftWrites.set(id, write)
  return write
}

export const registerReviewIpc = (): void => {
  ipcMain.handle('mt::review-attach', async(event, file: string): Promise<ReviewAttachment | null> => {
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
        round: typeof value.round === 'number' && Number.isInteger(value.round) && value.round > 0 ? value.round : 1,
        pending: value.pending
      }
    }
    const key = `${event.sender.id}:${entry.session.id}`
    if (!conversationWatchers.has(key)) {
      const statePath = conversationPath(entry.session.id)
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true })
      const watcher = chokidar.watch(path.dirname(statePath), { ignoreInitial: true, usePolling: true, interval: 250, depth: 0 })
      const update = () => {
        readConversation(entry.session.id).then(state => {
          if (!event.sender.isDestroyed()) event.sender.send('mt::review-state-changed', state)
        }).catch(error => console.error('Cannot refresh review conversation', error))
      }
      watcher.on('all', (_kind, filename) => { if (filename === statePath) update() })
        .on('error', error => console.error('Review watcher', error))
      const close = () => {
        void watcher.close()
        conversationWatchers.delete(key)
        event.sender.removeListener('destroyed', close)
      }
      conversationWatchers.set(key, close)
      event.sender.once('destroyed', close)
    }
    const conversation = await readConversation(entry.session.id)
    draft.round = Math.max(draft.round, ...conversation.rounds.map(batch => batch.round + 1))
    try {
      const auditFiles = await fs.promises.readdir(path.dirname(conversationPath(entry.session.id)))
      for (const filename of auditFiles) {
        const match = /^round-(\d+)\.json$/.exec(filename)
        if (match) draft.round = Math.max(draft.round, Number(match[1]) + 1)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      session: entry.session,
      draft,
      baseline: draft.baseline ?? await fs.promises.readFile(file, 'utf8'),
      conversation
    }
  })
  ipcMain.handle('mt::review-draft', (_event, id: string, draft: ReviewDraft) => saveDraft(id, draft))
  ipcMain.handle('mt::review-detach', (event, id: string) => conversationWatchers.get(`${event.sender.id}:${id}`)?.())
  ipcMain.handle('mt::review-state', (_event, id: string) => readConversation(id))
  ipcMain.handle('mt::review-resolve', async(_event, id: string, commentID: string, resolved: boolean) => {
    await postReview(id, '/review/resolve', { id, comment_id: commentID, resolved })
    return readConversation(id)
  })
  ipcMain.handle('mt::review-retry', async(_event, id: string, submissionID: string) => {
    await postReview(id, '/review/retry', { id, submission_id: submissionID })
    return readConversation(id)
  })
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
      if (!request.submission_id || !/^[a-zA-Z0-9_-]{1,128}$/.test(request.submission_id)) throw new Error('Missing submission id')
      const snapshotPath = path.join(path.dirname(entry.pathname), `${request.submission_id}.json`)
      let snapshot: { saved: string; route: string; body: unknown }
      if (fs.existsSync(snapshotPath)) {
        snapshot = JSON.parse(await fs.promises.readFile(snapshotPath, 'utf8'))
      } else {
        const saved = await fs.promises.readFile(session.file, 'utf8')
        const relpath = path.relative(session.track_root, session.file).split(path.sep).join('/')
        const payload = buildReviewPayload(request, relpath, saved)
        snapshot = request.mode === 'inline'
          ? { saved, route: '/review/comment', body: { id: request.id, submission_id: request.submission_id, diff: payload.diff, comment: payload.comments[0] } }
          : { saved, route: '/review/send', body: payload }
        await writeFileAtomic(snapshotPath, JSON.stringify(snapshot), { encoding: 'utf8' })
      }
      const result = await postReview(request.id, snapshot.route, snapshot.body)
      if ((request.mode !== 'inline' && result.round !== request.round) || typeof result.delivered !== 'boolean') {
        throw new Error('Invalid bridge response')
      }
      return { result, saved: snapshot.saved, conversation: await readConversation(request.id) }
    } finally {
      sending.delete(request.id)
    }
  })
}
