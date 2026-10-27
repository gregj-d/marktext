import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import type { ReviewPayload } from '../../src/shared/types/review'

test('unpacked Sloptown Review launches directly and sends to the bridge', async() => {
  const executable = process.env.SLOPTOWN_REVIEW_EXECUTABLE
  test.skip(!executable, 'Set SLOPTOWN_REVIEW_EXECUTABLE to the unpacked app binary')
  test.setTimeout(45000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloptown-packaged-'))
  const userData = path.join(dir, 'user-data')
  const file = path.join(dir, 'smoke.md')
  const sessionPath = path.join(dir, 'session.json')
  let received: ReviewPayload | undefined
  const server = http.createServer(async(req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString()) as ReviewPayload
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ round: received.round, delivered: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  fs.writeFileSync(file, 'Packaged app smoke\n')
  fs.writeFileSync(sessionPath, JSON.stringify({
    id: 'r_123456_cccc00', file, track_root: dir, thread: '', track_id: 'smoke',
    created_at: new Date().toISOString(), bridge: `http://127.0.0.1:${port}`
  }))
  let child: ChildProcess | undefined
  try {
    child = spawn(executable as string, [
      '--user-data-dir', userData, '--sloptown-review', sessionPath, file,
      '--remote-debugging-port=0'
    ], { stdio: 'ignore' })
    const devtools = path.join(userData, 'DevToolsActivePort')
    await expect.poll(() => fs.existsSync(devtools), { timeout: 15000 }).toBe(true)
    const cdpPort = fs.readFileSync(devtools, 'utf8').split('\n')[0]
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
    const page = browser.contexts()[0].pages()[0]
    await expect(page.locator('.review-panel')).toBeVisible()
    await page.getByRole('textbox', { name: 'Overall note' }).fill('Packaged smoke feedback')
    await page.getByRole('button', { name: 'Send review', exact: true }).click()
    await expect(page.locator('.review-status')).toContainText('Round 1: delivered')
    expect(received).toMatchObject({
      id: 'r_123456_cccc00', round: 1, diff: '', comments: [], note: 'Packaged smoke feedback'
    })
    expect(fs.readFileSync(file, 'utf8')).toBe('Packaged app smoke\n')
    await browser.close()
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child?.once('exit', () => resolve()))
      child.kill()
      await exited
    }
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
