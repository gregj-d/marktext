import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3955: newly created files appeared in the sidebar ~1s late because the
// directory watcher inherited chokidar's `awaitWriteFinish` (stabilityThreshold
// 1000ms), which defers `add`/`change` events until the file size settles. That
// protection (GH#1043) only matters for the file watcher, which reloads file
// CONTENT on change; the directory watcher just lists nodes and re-sorts by
// mtime. These tests pin that only the file watcher defers events.

const watchMock = vi.fn()

function fakeWatcher(): Record<string, ReturnType<typeof vi.fn>> {
  const w: Record<string, ReturnType<typeof vi.fn>> = {}
  w.on = vi.fn(() => w)
  w.close = vi.fn()
  w.add = vi.fn()
  w.unwatch = vi.fn()
  return w
}

vi.mock('chokidar', () => ({
  default: {
    watch: (...args: unknown[]) => {
      watchMock(...args)
      return fakeWatcher()
    }
  }
}))

// Importing the watcher pulls in the markdown loader, whose encoding detection
// uses the native `ced` addon. Its bindings are built for Electron's ABI, not
// the plain-Node test runner, so stub it to keep this spec import-only.
vi.mock('ced', () => ({ default: () => 'UTF-8' }))

import Watcher, {
  WATCHER_STABILITY_THRESHOLD,
  WATCHER_STABILITY_POLL_INTERVAL,
  isUncPath
} from 'main_renderer/filesystem/watcher'
import { reviewSessions } from 'main_renderer/reviewSessions'

function optionsForLastWatch(): Record<string, unknown> {
  const calls = watchMock.mock.calls
  return calls[calls.length - 1][1] as Record<string, unknown>
}

describe('watcher awaitWriteFinish (#3955)', () => {
  let watcher: Watcher
  const win = { id: 1, webContents: { send: vi.fn() } }

  beforeEach(() => {
    reviewSessions.clear()
    watchMock.mockClear()
    const preferences = { getItem: vi.fn(() => false) }
    watcher = new Watcher(preferences as never)
  })

  it('does not defer directory-tree events with awaitWriteFinish', () => {
    watcher.watch(win as never, '/project', 'dir')
    expect(optionsForLastWatch().awaitWriteFinish).toBeFalsy()
  })

  it('keeps awaitWriteFinish for the file watcher (GH#1043)', () => {
    watcher.watch(win as never, '/project/note.md', 'file')
    expect(optionsForLastWatch().awaitWriteFinish).toEqual({
      stabilityThreshold: WATCHER_STABILITY_THRESHOLD,
      pollInterval: WATCHER_STABILITY_POLL_INTERVAL
    })
  })

  it('forces polling for UNC roots because fs.watch does not enumerate WSL shares reliably', () => {
    watcher.watch(win as never, '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project', 'dir')
    expect(optionsForLastWatch().usePolling).toBe(true)
  })

  it('detects both backslash and slash UNC paths', () => {
    expect(isUncPath('\\\\server\\share\\project')).toBe(true)
    expect(isUncPath('//server/share/project')).toBe(true)
    expect(isUncPath('C:\\project')).toBe(false)
    expect(isUncPath('/home/me/project')).toBe(false)
  })

  it('does not suppress a fast agent write coalesced with the review save', async() => {
    const pathname = '/project/review.md'
    watcher.ignoreChangedEvent(win.id, pathname)
    reviewSessions.set('r_1_abcdef', {
      pathname: '/reviews/session.json',
      session: {
        id: 'r_1_abcdef', file: pathname, track_root: '/project', track_id: 'test',
        thread: '', bridge: 'http://127.0.0.1:1', created_at: ''
      }
    })
    expect(await watcher._shouldIgnoreEvent(win.id, pathname, 'file', true)).toBe(false)
    reviewSessions.clear()
  })

  it('still suppresses our own save event for ordinary documents', async() => {
    watcher.ignoreChangedEvent(win.id, '/project/normal.md')
    expect(await watcher._shouldIgnoreEvent(win.id, '/project/normal.md', 'file', true)).toBe(true)
  })
})
