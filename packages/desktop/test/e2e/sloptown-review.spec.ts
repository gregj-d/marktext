import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ReviewPayload, ReviewSession } from '../../src/shared/types/review'
import {
  focusEditor,
  clickMenuById,
  getElectronPath,
  launchElectron,
  setSourceMarkdown,
  waitForEditor,
  waitForMenuReady
} from './helpers'

test('review saves edits, sends a round, reloads agent changes and restores draft round', async() => {
  test.setTimeout(90000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloptown-review-'))
  const file = path.join(dir, 'plan.md')
  const sessionPath = path.join(dir, 'session.json')
  const received: ReviewPayload[] = []
  const server = http.createServer(async(req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: 1 }))
      return
    }
    expect(req.url).toBe('/review/send')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as ReviewPayload
    received.push(payload)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ round: payload.round, delivered: false, error: 'Thread is stopped' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const session: ReviewSession = {
    id: 'r_123456_abcdef',
    file,
    track_root: dir,
    thread: 'writer',
    track_id: 'test',
    bridge: 'http://127.0.0.1:1',
    created_at: new Date().toISOString()
  }
  fs.writeFileSync(file, 'Original wording\n')
  fs.writeFileSync(sessionPath, JSON.stringify(session))
  let running: Awaited<ReturnType<typeof launchElectron>> | undefined
  try {
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    let { app, page } = running
    await waitForEditor(page)
    await waitForMenuReady(app)
    await expect(page.getByRole('complementary', { name: 'Review', exact: true })).toBeVisible()
    const rail = await page.locator('.review-rail').boundingBox()
    const document = await page.locator('.editor-with-tabs').boundingBox()
    if (!rail || !document) throw new Error('Missing review workspace geometry')
    expect(rail.x).toBeGreaterThanOrEqual(document.x + document.width - 1)
    await clickMenuById(app, 'sideBarMenuItem')
    await expect(page.locator('.side-bar')).toHaveCount(0)
    await expect(page.locator('.side-bar .review-rail')).toHaveCount(0)
    await clickMenuById(app, 'sideBarMenuItem')
    await focusEditor(page)
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add comment', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toBeFocused()
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Keep this precise.')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await page.locator('.review-comment-text').click()
    await expect.poll(() => page.evaluate(() =>
      [...(CSS.highlights.get('sloptown-review-active') ?? [])][0]?.toString()
    )).toBe('Original wording')
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0)
    await expect(page.locator('.mu-format-picker-container')).toHaveCSS('opacity', '0')
    await page.getByRole('textbox', { name: 'Overall note' }).fill('Review note')
    await expect.poll(() => {
      const draft = path.join(dir, 'draft.json')
      return fs.existsSync(draft) ? JSON.parse(fs.readFileSync(draft, 'utf8')).comments[0]?.text : ''
    }).toBe('Keep this precise.')
    await setSourceMarkdown(page, app, 'User wording\n')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('User wording\n')
    await page.waitForTimeout(1500)
    expect(received).toHaveLength(0)
    await expect(page.locator('.review-card')).toHaveCount(1)
    await setSourceMarkdown(page, app, 'User wording\n\nSecond saved addition\n')
    await page.locator('.editor-component').focus()
    const browserWindow = await app.browserWindow(page)
    await browserWindow.evaluate(win => {
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers })
    })
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Second saved addition')
    await page.waitForTimeout(1500)
    expect(received).toHaveLength(0)
    await app.close()
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    ;({ app, page } = running)
    await waitForEditor(page)
    await waitForMenuReady(app)
    await expect(page.locator('.review-comment-text')).toContainText('Keep this precise.')
    await setSourceMarkdown(page, app, 'User wording\n\nSecond saved addition\n\nFinal addition\n')
    // The bridge can move ports without restarting the review application.
    fs.writeFileSync(sessionPath, JSON.stringify({ ...session, bridge: `http://127.0.0.1:${address.port}` }))
    await page.getByRole('button', { name: 'Send Review', exact: true }).click()
    await expect(page.locator('.review-status')).toContainText('Round 1: stored, not delivered')
    expect(fs.readFileSync(file, 'utf8')).toBe('User wording\n\nSecond saved addition\n\nFinal addition\n')
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      id: session.id,
      round: 1,
      note: 'Review note',
      comments: [{
        quote: 'Original wording', text: 'Keep this precise.', line: 1, prefix: '', suffix: '\n'
      }]
    })
    expect(received[0].diff).toContain('--- a/plan.md')
    expect(received[0].diff).toContain('+++ b/plan.md')
    expect(received[0].diff).toContain('+User wording')
    expect(received[0].diff).toContain('-Original wording')
    expect(received[0].diff).toContain('+Second saved addition')
    expect(received[0].diff).toContain('+Final addition')
    await expect(page.locator('.review-card')).toHaveCount(1)
    await expect(page.locator('.review-card .review-message')).toContainText('Keep this precise.')
    fs.writeFileSync(file, 'Agent wording\n')
    await expect(page.locator('.editor-component')).toContainText('Agent wording', { timeout: 15000 })
    await page.getByRole('textbox', { name: 'Overall note' }).fill('Only a note this round')
    await page.getByRole('button', { name: 'Send Review', exact: true }).click()
    await expect(page.locator('.review-status')).toContainText('Round 2:')
    expect(received[1].diff).toBe('')
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf8')).round).toBe(3)
    await app.close()
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    await expect(running.page.locator('.review-rail')).toBeVisible()
    await expect(running.page.locator('.review-status')).toBeEmpty()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf8')).round).toBe(3)
  } finally {
    await running?.app.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a second-instance review attaches to an already-open tab without duplicating it', async() => {
  test.setTimeout(45000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloptown-second-'))
  const file = path.join(dir, 'plan.md')
  fs.writeFileSync(file, 'Existing document\n')
  const { app, page } = await launchElectron([file])
  try {
    await waitForEditor(page)
    const sessionPath = path.join(dir, 'session.json')
    fs.writeFileSync(sessionPath, JSON.stringify({
      id: 'r_123456_abcd00', file, track_root: dir, track_id: 'test',
      thread: '', bridge: 'http://127.0.0.1:1', created_at: new Date().toISOString()
    }))
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const child = spawn(getElectronPath(), [
      path.resolve(__dirname, '../..'), '--user-data-dir', userData,
      '--sloptown-review', sessionPath, file,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ], { env: { ...process.env, PERF_TESTING: 'true' }, stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Second instance did not exit'))
      }, 15000)
      child.once('error', reject)
      child.once('exit', code => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    expect(code).toBe(0)
    await expect(page.getByRole('complementary', { name: 'Review', exact: true })).toBeVisible()
    await expect(page.locator('.tabs-container > li', { hasText: 'plan.md' })).toHaveCount(1)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
