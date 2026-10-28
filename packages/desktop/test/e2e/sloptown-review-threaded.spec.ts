import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { ReviewConversation } from '../../src/shared/types/review'
import { launchElectron, setSourceMarkdown, waitForEditor, waitForMenuReady } from './helpers'

test('inline and batch requests receive live threaded replies without losing private drafts', async() => {
  test.setTimeout(90000)
  const bridge = process.env.SLOPTOWN_TEST_BRIDGE
  const cli = process.env.SLOPTOWN_TEST_REVIEW_CLI
  test.skip(!bridge || !cli, 'Set SLOPTOWN_TEST_BRIDGE and SLOPTOWN_TEST_REVIEW_CLI for cross-repository integration')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-threaded-'))
  const file = path.join(dir, 'plan.md')
  const home = path.join(dir, 'state')
  const mock = path.join(dir, 'bin')
  fs.mkdirSync(mock)
  fs.writeFileSync(path.join(mock, 'launcher'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const fail = path.join(dir, 'fail')
  fs.writeFileSync(path.join(mock, 'sbx'), `#!/bin/sh\nprintf 'call\\n' >> '${dir}/deliveries'\n[ -f '${fail}' ] && exit 1\nexit 0\n`, { mode: 0o755 })
  fs.writeFileSync(file, '# Plan\n\nAlpha text.\n\nBeta text.\n\nGamma text.\n')
  const child = spawn(bridge as string, [], {
    env: {
      ...process.env, STX_HOME: home, SLOPTOWN_TRACK_ROOT: dir,
      THREAD_BRIDGE_SESSION: 'test', SLOPTOWN_SANDBOX: 'test',
      THREAD_BRIDGE_PORT: '0', THREAD_BRIDGE_REVIEW_LAUNCHER: path.join(mock, 'launcher'),
      STX_BIN: '', PATH: `${mock}:${process.env.PATH}`
    }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let running: Awaited<ReturnType<typeof launchElectron>> | undefined
  let proxy: http.Server | undefined
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Bridge startup timed out')), 15000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = /THREAD_BRIDGE_PORT=(\d+)/.exec(output)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      child.once('error', reject)
    })
    const endpoint = `http://127.0.0.1:${port}`
    const opened = await fetch(`${endpoint}/review`, { method: 'POST', body: JSON.stringify({ path: file, thread: 'writer' }) })
    expect(opened.status).toBe(200)
    const { id } = await opened.json() as { id: string }
    const sessionPath = path.join(home, 'reviews', id, 'session.json')
    const draftPath = path.join(home, 'reviews', id, 'draft.json')
    let dropFirstInlineResponse = true
    proxy = http.createServer(async(req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await fetch(`${endpoint}${req.url}`, {
        method: req.method, body: req.method === 'GET' ? undefined : Buffer.concat(chunks).toString(), headers: { 'Content-Type': 'application/json' }
      })
      const text = await response.text()
      if (req.url === '/review/comment' && dropFirstInlineResponse) {
        dropFirstInlineResponse = false
        res.destroy()
        return
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' })
      res.end(text)
    })
    await new Promise<void>(resolve => proxy?.listen(0, '127.0.0.1', resolve))
    const proxyPort = (proxy.address() as { port: number }).port
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))
    fs.writeFileSync(sessionPath, JSON.stringify({ ...session, bridge: `http://127.0.0.1:${proxyPort}` }))
    fs.writeFileSync(draftPath, JSON.stringify({
      round: 1, note: '', comments: [
        { id: 'c_inline', message_id: 'm_inline', quote: 'Alpha', prefix: '', suffix: ' text.', line: 3, text: 'Inline request.', ready: true },
        { id: 'c_batch', message_id: 'm_batch', quote: 'Beta', prefix: '', suffix: ' text.', line: 5, text: 'Batch request.', ready: true },
        { id: 'c_private', message_id: 'm_private', quote: 'Gamma', prefix: '', suffix: ' text.', line: 7, text: 'Unfinished draft.', ready: false }
      ]
    }))
    const state = async(): Promise<ReviewConversation> => await (await fetch(`${endpoint}/review/state?id=${id}`)).json() as ReviewConversation
    const reply = (args: string[]) => execFileSync(cli as string, ['reply', file, ...args], {
      env: { ...process.env, THREAD_BRIDGE_ENDPOINT: endpoint }, encoding: 'utf8'
    })
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    let { app, page } = running
    await waitForEditor(page)
    await waitForMenuReady(app)
    await expect(page.locator('.review-card')).toHaveCount(3)
    await setSourceMarkdown(page, app, '# Plan\n\nAlpha text.\n\nBeta text.\n\nGamma text.\n\nUser addition.\n')
    let first = page.locator('.review-card').first()
    await first.hover()
    await first.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry send', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry send', exact: true })).toBeEnabled()
    await expect.poll(() => JSON.parse(fs.readFileSync(draftPath, 'utf8')).pending?.submission_id).toBeTruthy()
    await app.close()
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    ;({ app, page } = running)
    await waitForEditor(page)
    first = page.locator('.review-card').first()
    await page.getByRole('button', { name: 'Retry send', exact: true }).click()
    await expect(first.locator('.review-message')).toContainText('Inline request.')
    await expect(page.getByRole('button', { name: 'Retry send', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send Review', exact: true })).toBeEnabled()
    expect(fs.readFileSync(path.join(dir, 'deliveries'), 'utf8').trim().split('\n')).toHaveLength(1)
    await expect.poll(async() => (await state()).threads.length).toBe(1)
    const initial = await state()
    expect(initial.threads[0].messages[0].id).toBe('m_inline')
    const inlineAudit = JSON.parse(fs.readFileSync(path.join(dir, '.agents/reviews', id, `${initial.submissions[0].id}.json`), 'utf8'))
    expect(inlineAudit.diff).toContain('+User addition.')
    await page.locator('.review-card').last().focus()
    await page.locator('.review-card').last().getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Private work in progress.')
    await page.getByRole('textbox', { name: 'Overall note' }).fill('Overall review note.')
    await page.getByRole('button', { name: 'Send Review', exact: true }).click()
    await expect.poll(async() => (await state()).rounds.length).toBe(1)
    const batchState = await state()
    expect(batchState.threads).toHaveLength(2)
    expect(batchState.rounds[0].comment_message_ids).toEqual(['m_batch'])
    expect(batchState.rounds[0].inline_message_ids).toEqual(['m_inline'])
    const batchAudit = JSON.parse(fs.readFileSync(path.join(dir, '.agents/reviews', id, 'round-1.json'), 'utf8'))
    expect(batchAudit.diff).toBe('')
    expect(batchAudit.comments).toHaveLength(1)
    expect(batchAudit.comments[0].id).toBe('c_batch')
    const noteID = batchState.rounds[0].note_id
    const premature = await fetch(`${endpoint}/review/reply`, { method: 'POST', body: JSON.stringify({
      id, round: 1, reply_to: noteID, message_id: 'm_premature', text: 'Too early'
    }) })
    expect(premature.status).toBe(409)
    await page.getByRole('textbox', { name: 'Comment', exact: true }).focus()
    reply(['--comment', 'c_inline', '--reply-to', 'm_inline', '--message', 'Inline issue addressed.'])
    await expect(first.locator('.review-agent-reply')).toContainText('Inline issue addressed.')
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('Private work in progress.')
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toBeFocused()
    reply(['--comment', 'c_batch', '--reply-to', 'm_batch', '--message', 'Batch issue addressed.'])
    reply(['--round', '1', '--reply-to', noteID, '--message', 'All submitted comments addressed; overall note checked.'])
    await expect(page.locator('.review-batch .review-agent-reply')).toContainText('overall note checked')
    await page.screenshot({ path: '/tmp/sloptown-review-threaded.png' })
    await expect(page.locator('.review-card')).toHaveCount(3)
    await first.hover()
    await first.getByRole('button', { name: 'Resolve', exact: true }).click()
    await expect(page.locator('.review-card')).toHaveCount(2)
    expect((await state()).threads[0].status).toBe('resolved')
    await page.getByRole('button', { name: 'Show resolved', exact: true }).click()
    await page.locator('.review-card').first().hover()
    await page.getByRole('button', { name: 'Reopen', exact: true }).click()
    await expect.poll(async() => (await state()).threads[0].status).toBe('open')
    await first.hover()
    await first.getByRole('button', { name: 'Reply', exact: true }).click()
    await first.getByRole('textbox', { name: 'Comment', exact: true }).fill('One follow-up.')
    fs.writeFileSync(fail, '')
    await first.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Retry delivery' })).toHaveCount(1)
    const followupState = await state()
    const followupID = followupState.threads[0].messages[2].id
    fs.unlinkSync(fail)
    await page.getByRole('button', { name: 'Retry delivery' }).click()
    await expect(page.getByRole('button', { name: 'Retry delivery' })).toHaveCount(0)
    expect((await state()).threads[0].messages).toHaveLength(3)
    reply(['--comment', 'c_inline', '--reply-to', followupID, '--message', 'Follow-up addressed.'])
    await expect(first).toContainText('Follow-up addressed.')
    await app.close()
    running = await launchElectron(['--sloptown-review', sessionPath, file])
    ;({ app, page } = running)
    await waitForEditor(page)
    await expect(page.locator('.review-card').first()).toContainText('Follow-up addressed.')
    await expect(page.locator('.review-comments')).toContainText('Private work in progress.')
    await expect(page.locator('.review-batch')).toContainText('overall note checked')
    expect((await state()).threads[0].messages).toHaveLength(4)
    await waitForMenuReady(app)
    await setSourceMarkdown(page, app, '# Plan\n\nUnsaved user wording.\n')
    fs.writeFileSync(file, '# Plan\n\nAgent change on disk.\n')
    await expect(page.locator('.editor-notifications')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.editor-component')).toContainText('Unsaved user wording.')
    await expect(page.locator('.editor-component')).not.toContainText('Agent change on disk.')
  } finally {
    await running?.app.close()
    if (proxy) {
      proxy.closeAllConnections()
      await new Promise<void>(resolve => proxy?.close(() => resolve()))
    }
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill()
    await exited
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
