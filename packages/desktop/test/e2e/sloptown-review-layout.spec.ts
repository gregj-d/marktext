import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { clickMenuById, launchElectron, waitForEditor, waitForMenuReady } from './helpers'

test('review uses one far-right scrollbar for document and comments without a gutter', async() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloptown-layout-'))
  const file = path.join(dir, 'layout.md')
  const session = path.join(dir, 'session.json')
  fs.writeFileSync(file, Array.from({ length: 80 }, (_, i) => `Paragraph ${i} of the review document.`).join('\n\n') + '\n')
  fs.writeFileSync(session, JSON.stringify({
    id: 'r_123456_aabb11', file, track_root: dir, track_id: 'test', thread: '',
    bridge: 'http://127.0.0.1:1', created_at: new Date().toISOString()
  }))
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({
    comments: [{ quote: 'Paragraph 0', prefix: '', suffix: ' of the review document.', line: 1, text: 'A review comment.' }],
    note: '', round: 1
  }))
  const { app, page } = await launchElectron(['--sloptown-review', session, file])
  try {
    await waitForEditor(page)
    await waitForMenuReady(app)
    if (!await page.locator('.editor-tabs').isVisible()) await clickMenuById(app, 'tabBarMenuItem')
    await expect(page.locator('.review-card')).toHaveCount(1)
    const viewport = page.locator('.review-workspace')
    const geometry = () => page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.review-workspace')
      const rail = document.querySelector<HTMLElement>('.review-rail')
      const editor = document.querySelector<HTMLElement>('.editor-component')
      const comments = document.querySelector<HTMLElement>('.review-comments')
      const text = editor?.querySelector('.mu-paragraph-content')
      const card = document.querySelector('.review-card')
      const footer = document.querySelector('.review-footer')
      if (!viewport || !rail || !editor || !comments || !text || !card || !footer) throw new Error('Missing review layout')
      return {
        top: viewport.scrollTop,
        right: viewport.getBoundingClientRect().left + viewport.clientWidth,
        railRight: rail.getBoundingClientRect().right,
        textY: text.getBoundingClientRect().top,
        cardY: card.getBoundingClientRect().top,
        editorOverflow: getComputedStyle(editor).overflowY,
        commentsOverflow: getComputedStyle(comments).overflowY,
        footerBottom: footer.getBoundingClientRect().bottom,
        viewportBottom: viewport.getBoundingClientRect().bottom,
        horizontalOverflow: viewport.scrollWidth - viewport.clientWidth
      }
    })
    const browserWindow = await app.browserWindow(page)
    for (const width of [900, 1500]) {
      await browserWindow.evaluate((win, width) => win.setSize(width, 800), width)
      await expect.poll(async() => {
        const box = await geometry()
        return Math.abs(box.right - box.railRight)
      }).toBeLessThanOrEqual(1)
      expect((await geometry()).horizontalOverflow).toBeLessThanOrEqual(1)
    }
    await viewport.evaluate(element => { element.scrollTop = 0 })
    await page.locator('.review-header').click()
    const before = await geometry()
    expect(before.editorOverflow).toBe('visible')
    expect(before.commentsOverflow).toBe('visible')
    const railBox = await page.locator('.review-rail').boundingBox()
    if (!railBox) throw new Error('Missing rail')
    await page.mouse.move(railBox.x + 30, 300)
    await page.mouse.wheel(0, 180)
    await expect.poll(async() => (await geometry()).top).toBeGreaterThan(80)
    const after = await geometry()
    const delta = after.top - before.top
    expect(Math.abs(before.textY - after.textY - delta)).toBeLessThan(2)
    expect(Math.abs(before.cardY - after.cardY - delta)).toBeLessThan(2)
    expect(Math.abs(after.footerBottom - after.viewportBottom)).toBeLessThan(2)
    await viewport.evaluate(element => { element.scrollTop = 0 })
    const editorBox = await page.locator('.editor-with-tabs').boundingBox()
    if (!editorBox) throw new Error('Missing editor')
    await page.mouse.move(editorBox.x + editorBox.width / 2, 300)
    await page.mouse.wheel(0, 180)
    await expect.poll(async() => (await geometry()).top).toBeGreaterThan(80)
    await viewport.evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: '/tmp/sloptown-review-shared-scroll.png' })
    await viewport.evaluate(element => new Promise<void>(resolve => {
      element.scrollTop = 400
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(400)
    const other = path.join(dir, 'ordinary.md')
    fs.writeFileSync(other, fs.readFileSync(file, 'utf8'))
    await page.evaluate(file => window.electron.ipcRenderer.send('mt::open-file', file), other)
    await expect(page.locator('.review-workspace')).toHaveCount(0)
    await expect.poll(() => page.locator('.editor-workspace').evaluate(element => element.scrollTop)).toBe(0)
    expect(await page.locator('.editor-component').evaluate(element => getComputedStyle(element).overflowY)).toBe('auto')
    await page.locator('.tabs-container > li', { hasText: 'layout.md' }).click()
    await expect(page.locator('.review-workspace')).toBeVisible()
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(400)
    await viewport.evaluate(element => { element.scrollTop = 0 })
    await page.locator('.review-card').hover()
    await page.getByRole('button', { name: 'Resolve', exact: true }).click()
    await expect(page.locator('.review-comments')).toBeEmpty()
    await expect(page.locator('.review-rail')).not.toContainText('Select text')
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
