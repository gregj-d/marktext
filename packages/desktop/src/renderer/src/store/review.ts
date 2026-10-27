import { computed, reactive, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ReviewAttachment, ReviewComment, ReviewResult } from '@shared/types/review'
import { anchorComment } from 'common/review'
import { useEditorStore } from './editor'
import { useLayoutStore } from './layout'
import { captureReviewSelection, selectReviewQuote } from '../services/reviewSelection'
import bus from '../bus'

interface ReviewState extends ReviewAttachment {
  sending: boolean
  error: string
  result: ReviewResult | null
  reloadRevision: number
}

export const useReviewStore = defineStore('review', () => {
  const editor = useEditorStore()
  const layout = useLayoutStore()
  const tabs = reactive<Record<string, ReviewState>>({})
  const active = computed(() => tabs[editor.currentFile?.id ?? ''] ?? null)
  const attaching = new Set<string>()
  let selection: { quote: string; offset?: number } = { quote: '' }

  const open = (): void => layout.SET_LAYOUT({ rightColumn: 'review', showSideBar: true })

  async function attach(): Promise<void> {
    const tab = editor.currentFile
    if (!tab?.pathname || attaching.has(tab.id)) return
    if (tabs[tab.id]) return
    attaching.add(tab.id)
    try {
      const attachment = await window.electron.ipcRenderer.invoke('mt::review-attach', tab.pathname)
      if (!attachment || !editor.tabs.some(item => item.id === tab.id)) return
      tabs[tab.id] = {
        ...attachment,
        sending: false,
        error: '',
        result: null,
        reloadRevision: 0
      }
      if (editor.currentFile?.id === tab.id) open()
    } catch (error) {
      console.error('Cannot attach review session', error)
    } finally {
      attaching.delete(tab.id)
    }
  }

  function addComment(quote?: string): void {
    if (!active.value || active.value.sending || !editor.currentFile) return
    editor.flushActiveEditor()
    const selected = quote ? { quote, offset: selection.offset } : captureReviewSelection()
    const anchor = selected.quote ? selected : selection
    if (!anchor.quote.trim()) return
    active.value.draft.comments.push(anchorComment(editor.currentFile.markdown, anchor.quote, anchor.offset))
    open()
  }

  function findComment(comment: ReviewComment): void {
    if (!editor.currentFile) return
    selectReviewQuote(editor.currentFile.markdown, comment)
  }

  async function send(): Promise<void> {
    const review = active.value
    const tab = editor.currentFile
    if (!review || !tab || review.sending) return
    review.sending = true
    review.error = ''
    const revision = review.reloadRevision
    try {
      const saved = await editor.FILE_SAVE({ waitForResult: true })
      if (saved?.status !== 'saved') throw new Error('File was not saved; review was not sent.')
      if (saved.pathname !== review.session.file) throw new Error('Review file path changed; reopen the review.')
      const response = await window.electron.ipcRenderer.invoke('mt::review-send', {
        id: review.session.id,
        baseline: review.baseline,
        ...JSON.parse(JSON.stringify(review.draft))
      })
      review.result = response.result
      // An agent may finish and reload the document before the HTTP reply arrives.
      if (review.reloadRevision === revision) review.baseline = response.saved
      review.draft = { comments: [], note: '', round: response.result.round + 1 }
    } catch (error) {
      review.error = String(error)
    } finally {
      review.sending = false
    }
  }

  function initialize(): () => void {
    const stopClosedTabWatch = watch(() => editor.tabs.map(tab => tab.id), ids => {
      for (const id of Object.keys(tabs)) {
        if (!ids.includes(id)) delete tabs[id]
      }
    })
    const stopTabWatch = watch(
      () => [editor.currentFile?.id, editor.currentFile?.pathname],
      () => {
        selection = { quote: '', offset: undefined }
        void attach()
        if (active.value) open()
      },
      { immediate: true }
    )
    const stopDraftWatch = watch(
      () => Object.values(tabs).map(review => ({
        id: review.session.id,
        draft: review.draft,
        sending: review.sending
      })),
      (reviews) => {
        for (const review of reviews) {
          if (review.sending) continue
          const snapshot = JSON.parse(JSON.stringify(review.draft))
          window.electron.ipcRenderer.invoke('mt::review-draft', review.id, snapshot).catch(error => {
            const state = Object.values(tabs).find(item => item.session.id === review.id)
            if (state) state.error = `Could not save draft: ${error}`
          })
        }
      },
      { deep: true }
    )
    const stopSessionListener = window.electron.ipcRenderer.on('mt::review-sessions-changed', () => {
      void attach()
      if (active.value) open()
    })
    const stopCommentListener = window.electron.ipcRenderer.on('mt::review-comment-selection', (_event, quote) => addComment(quote))
    const onSelection = (): void => {
      const captured = captureReviewSelection()
      if (captured.quote) selection = captured
    }
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm' && active.value) {
        event.preventDefault()
        event.stopImmediatePropagation()
        addComment()
      }
    }
    const onReload = (payload: unknown): void => {
      const { id, markdown } = payload as { id: string; markdown: string }
      const review = tabs[id]
      if (review) {
        review.baseline = markdown
        review.reloadRevision++
      }
    }
    document.addEventListener('selectionchange', onSelection)
    document.addEventListener('keydown', onKey, true)
    bus.on('review-baseline', onReload)
    return () => {
      stopClosedTabWatch()
      stopTabWatch()
      stopDraftWatch()
      stopSessionListener()
      stopCommentListener()
      document.removeEventListener('selectionchange', onSelection)
      document.removeEventListener('keydown', onKey, true)
      bus.off('review-baseline', onReload)
    }
  }

  return { tabs, active, open, addComment, findComment, send, initialize }
})
