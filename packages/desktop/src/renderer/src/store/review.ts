import { computed, reactive, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ReviewAttachment, ReviewComment, ReviewResult } from '@shared/types/review'
import { useEditorStore } from './editor'
import { captureReviewSelection, selectReviewQuote, type ReviewSelection } from '../services/reviewSelection'
import bus from '../bus'

interface ReviewState extends ReviewAttachment {
  sending: boolean
  error: string
  result: ReviewResult | null
  reloadRevision: number
  saving: boolean
  saveStatus: string
  activeComment: number | null
  editingComment: number | null
}

export const useReviewStore = defineStore('review', () => {
  const editor = useEditorStore()
  const tabs = reactive<Record<string, ReviewState>>({})
  const active = computed(() => tabs[editor.currentFile?.id ?? ''] ?? null)
  const attaching = new Set<string>()

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
        reloadRevision: 0,
        saving: false,
        saveStatus: '',
        activeComment: null,
        editingComment: null
      }
    } catch (error) {
      console.error('Cannot attach review session', error)
    } finally {
      attaching.delete(tab.id)
    }
  }

  async function persist(review: ReviewState): Promise<void> {
    const draft = JSON.parse(JSON.stringify({ ...review.draft, baseline: review.baseline }))
    await window.electron.ipcRenderer.invoke('mt::review-draft', review.session.id, draft)
  }

  async function save(): Promise<void> {
    const review = active.value
    if (!review || review.saving || review.sending) return
    review.saving = true
    review.error = ''
    try {
      const result = await editor.FILE_SAVE({ waitForResult: true })
      if (result?.status !== 'saved') throw new Error('File was not saved.')
      await persist(review)
      review.saveStatus = 'Saved. Review not sent.'
    } catch (error) {
      review.error = String(error)
    } finally {
      review.saving = false
    }
  }

  function addComment(selected: ReviewSelection | null = captureReviewSelection()): void {
    if (!active.value || active.value.sending || !editor.currentFile) return
    editor.flushActiveEditor()
    if (!selected?.comment.quote.trim()) return
    if (selected.range && (!selected.range.startContainer.isConnected || !selected.range.endContainer.isConnected)) return
    active.value.draft.comments.push({ ...selected.comment })
    active.value.activeComment = active.value.draft.comments.length - 1
    active.value.editingComment = active.value.activeComment
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
        ...JSON.parse(JSON.stringify(review.draft)),
        baseline: review.baseline
      })
      review.result = response.result
      // An agent may finish and reload the document before the HTTP reply arrives.
      if (review.reloadRevision === revision) review.baseline = response.saved
      review.draft = { comments: [], note: '', round: response.result.round + 1 }
      review.activeComment = null
      review.editingComment = null
      review.saveStatus = ''
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
        void attach()
      },
      { immediate: true }
    )
    const stopDraftWatch = watch(
      () => Object.values(tabs).map(review => ({
        id: review.session.id,
        draft: review.draft,
        baseline: review.baseline,
        sending: review.sending
      })),
      (reviews) => {
        for (const review of reviews) {
          if (review.sending) continue
          const snapshot = JSON.parse(JSON.stringify({ ...review.draft, baseline: review.baseline }))
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
    })
    const stopCommentListener = window.electron.ipcRenderer.on('mt::review-comment-selection', () => addComment())
    const stopSaveListener = window.electron.ipcRenderer.on('mt::tab-saved', (_event, id) => {
      const review = tabs[id]
      if (review && !review.sending) {
        review.saveStatus = 'Saved. Review not sent.'
        void persist(review).catch(error => { review.error = String(error) })
      }
    })
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
    document.addEventListener('keydown', onKey, true)
    bus.on('review-baseline', onReload)
    return () => {
      stopClosedTabWatch()
      stopTabWatch()
      stopDraftWatch()
      stopSessionListener()
      stopCommentListener()
      stopSaveListener()
      document.removeEventListener('keydown', onKey, true)
      bus.off('review-baseline', onReload)
    }
  }

  return { tabs, active, addComment, findComment, save, send, initialize }
})
