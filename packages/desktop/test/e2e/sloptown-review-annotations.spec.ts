import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchElectron, setSourceMarkdown, waitForEditor, waitForMenuReady } from './helpers'

async function selectQuote(page: Page, paragraph: string, quote: string): Promise<void> {
  await page.evaluate(({ paragraph, quote }) => {
    const root = document.querySelector<HTMLElement>('.editor-component')
    if (!root) throw new Error('Missing editor')
    const content = [...root.querySelectorAll<HTMLElement>('.mu-paragraph-content')]
      .find(element => element.textContent?.includes(paragraph))
    if (!content) throw new Error('Missing paragraph')
    const nodes: Text[] = []
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.parentElement?.closest('.mu-remove, .mu-hide')) nodes.push(node)
    }
    const text = nodes.map(node => node.data).join('')
    const start = text.indexOf(quote)
    if (start < 0) throw new Error(`Missing rendered quote: ${quote}`)
    const range = document.createRange()
    let cursor = 0
    for (const node of nodes) {
      if (start >= cursor && start < cursor + node.length) range.setStart(node, start - cursor)
      if (start + quote.length > cursor && start + quote.length <= cursor + node.length) {
        range.setEnd(node, start + quote.length - cursor)
        break
      }
      cursor += node.length
    }
    root.focus()
    content.scrollIntoView({ block: 'center' })
    const selected = window.getSelection()
    if (!selected) throw new Error('Missing document selection')
    selected.removeAllRanges()
    selected.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    root.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
  }, { paragraph, quote })
}

async function highlights(page: Page) {
  return page.evaluate(() => [...(CSS.highlights.get('sloptown-review') ?? [])].map(range => ({
    text: range.toString(),
    parent: range.startContainer.parentElement?.closest('.mu-paragraph-content')?.textContent
  })))
}

test('right-margin comments highlight exact inline anchors without changing markdown', async() => {
  test.setTimeout(90000)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sloptown-anchors-'))
  const file = path.join(dir, 'anchors.md')
  const sessionPath = path.join(dir, 'session.json')
  const markdown = 'First repeated target here.\n\nSecond repeated target there.\n\nBefore **bold** and *italic* after.\n\n' +
    Array.from({ length: 24 }, (_, i) => `Filler paragraph ${i} for scroll testing.`).join('\n\n') + '\n'
  fs.writeFileSync(file, markdown)
  fs.writeFileSync(sessionPath, JSON.stringify({
    id: 'r_123456_aabb00', file, track_root: dir, track_id: 'test', thread: '',
    bridge: 'http://127.0.0.1:1', created_at: new Date().toISOString()
  }))
  const { app, page } = await launchElectron(['--sloptown-review', sessionPath, file])
  try {
    await waitForEditor(page)
    await waitForMenuReady(app)
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0)
    await selectQuote(page, 'Second repeated', 'repeated target')
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.activeElement?.closest('.editor-component') !== null)).toBe(true)
    await page.getByRole('button', { name: 'Add comment', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toBeFocused()
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Only the second occurrence.')
    await page.getByRole('textbox', { name: 'Comment', exact: true }).press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
    await expect(page.locator('.review-card').first()).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveCount(0)
    await expect.poll(() => highlights(page)).toEqual([{
      text: 'repeated target', parent: 'Second repeated target there.'
    }])
    await selectQuote(page, 'Before', 'bold and italic')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+m' : 'Control+Shift+m')
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Across inline formatting.')
    await page.getByRole('textbox', { name: 'Comment', exact: true }).press('Escape')
    await expect.poll(async() => (await highlights(page)).length).toBe(2)
    await expect(page.locator('.review-header')).toHaveText('Review')
    await expect(page.getByRole('textbox', { name: 'Overall note' })).toHaveAttribute('rows', '1')
    await page.screenshot({ path: '/tmp/sloptown-review-minimal-light.png' })
    const darkStyle = await page.addStyleTag({
      content: fs.readFileSync(path.resolve('src/renderer/src/assets/themes/dark.theme.css'), 'utf8')
    })
    expect(await page.locator('.review-send').evaluate(element =>
      getComputedStyle(element).backgroundColor
    )).toBe('rgb(64, 158, 255)')
    await page.screenshot({ path: '/tmp/sloptown-review-minimal-dark.png' })
    await darkStyle.evaluate(element => element.parentNode?.removeChild(element))
    await page.locator('.review-header').click()
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0)
    await page.evaluate(() => {
      const range = [...(CSS.highlights.get('sloptown-review') ?? [])][0] as Range
      range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    })
    const highlightedPoint = await page.evaluate(() => {
      const range = [...(CSS.highlights.get('sloptown-review') ?? [])][0] as Range
      const rect = [...range.getClientRects()].find(rect => rect.width > 0)
      if (!rect) throw new Error('Missing highlight geometry')
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    await page.mouse.click(highlightedPoint.x, highlightedPoint.y)
    await expect(page.locator('.review-card').first()).toHaveClass(/active/)
    await expect.poll(() => page.evaluate(() =>
      [...(CSS.highlights.get('sloptown-review-active') ?? [])][0]?.toString()
    )).toBe('repeated target')
    await expect(page.locator('.review-comments')).not.toContainText('repeated target')
    await expect(page.locator('.review-comments')).not.toContainText('bold and italic')
    await expect(page.locator('.review-comments ol, .review-comments blockquote, .review-quote')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Comment on selection' })).toHaveCount(0)
    await page.getByRole('textbox', { name: 'Overall note' }).fill('Outside editor selection')
    await expect(page.getByRole('textbox', { name: 'Overall note' })).toHaveAttribute('rows', '3')
    await page.getByRole('textbox', { name: 'Overall note' }).evaluate(element => (element as HTMLTextAreaElement).select())
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+m' : 'Control+Shift+m')
    await expect(page.locator('.review-card')).toHaveCount(2)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe(markdown)
    await page.locator('.review-card').first().click({ position: { x: 15, y: 15 } })
    await expect(page.locator('.review-card').first()).toHaveClass(/active/)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('repeated target')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toHaveCount(0)
    await page.evaluate(() => {
      const root = document.querySelector('.editor-component')
      if (root) root.scrollTop = 1000
    })
    await expect.poll(async() => (await highlights(page)).length).toBe(2)
    await setSourceMarkdown(page, app, 'Added before anchors.\n\n' + markdown)
    await expect.poll(async() => (await highlights(page)).length).toBe(2)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('Added before anchors.')
    const other = path.join(dir, 'other.md')
    fs.writeFileSync(other, 'Not a review document.\n')
    await page.evaluate(pathname => window.electron.ipcRenderer.send('mt::open-file', pathname), other)
    await expect(page.locator('.review-rail')).toHaveCount(0)
    await expect(page.locator('.side-bar')).toHaveCount(1)
    expect(await page.evaluate(() => CSS.highlights.has('sloptown-review'))).toBe(false)
    await page.evaluate(pathname => window.electron.ipcRenderer.send('mt::open-file', pathname), file)
    await expect(page.locator('.review-rail')).toBeVisible()
    await expect(page.locator('.side-bar')).toHaveCount(0)
    await expect.poll(async() => (await highlights(page)).length).toBe(2)
    fs.writeFileSync(file, 'Agent prefix.\n\nAdded before anchors.\n\n' + markdown)
    await expect(page.locator('.editor-component')).toContainText('Agent prefix.', { timeout: 15000 })
    await expect.poll(async() => (await highlights(page)).length).toBe(2)
    await setSourceMarkdown(page, app, 'Agent prefix.\n\n' + markdown.replace('Second repeated target there.\n\n', ''))
    await expect(page.locator('.review-card').first()).toHaveClass(/detached/)
    await expect(page.locator('.review-card').first()).toContainText('Text no longer found')
    await expect.poll(async() => (await highlights(page)).length).toBe(1)
    await page.locator('.review-card').last().hover()
    await page.locator('.review-card').last().getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toBeFocused()
    await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Edited comment.')
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('.review-card').last()).toContainText('Edited comment.')
    await page.locator('.review-card').first().hover()
    await page.locator('.review-card').first().getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.locator('.review-card')).toHaveCount(1)
    await app.evaluate(({ Menu, BrowserWindow }) => {
      const original = Menu.prototype.popup
      Menu.prototype.popup = function(options) {
        const item = this.items.find(item => item.label === 'Comment on selection')
        if (!item) {
          original.call(this, options)
          return
        }
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        item.click(undefined, win, win?.webContents)
      }
    })
    await selectQuote(page, 'First repeated', 'repeated target')
    const contextPoint = await page.evaluate(() => {
      const range = window.getSelection()?.getRangeAt(0)
      if (!range) throw new Error('Missing selection')
      const rect = range.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    await page.mouse.click(contextPoint.x, contextPoint.y, { button: 'right' })
    await expect(page.locator('.review-card')).toHaveCount(2)
    await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toBeFocused()
  } finally {
    await app.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
