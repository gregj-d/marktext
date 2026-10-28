import { computed, reactive, watch } from 'vue'
import { defineStore } from 'pinia'
import type { ReviewAttachment, ReviewComment, ReviewConversation, ReviewResult, ReviewSendRequest } from '@shared/types/review'
import { useEditorStore } from './editor'
import { captureReviewSelection, selectReviewQuote, type ReviewSelection } from '../services/reviewSelection'
import bus from '../bus'

interface ReviewState extends ReviewAttachment {
  conversation: ReviewConversation
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
  const makeID = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
  const emptyConversation = (id: string): ReviewConversation => ({ version: 1, id, revision: 0, threads: [], rounds: [], submissions: [] })

  function mergeConversation(state: ReviewState, incoming: ReviewConversation): void {
    if (incoming.id !== state.session.id || incoming.revision < state.conversation.revision) return
    state.conversation = incoming
    state.draft.round = Math.max(state.draft.round, ...incoming.rounds.map(round => round.round + 1))
    for (const thread of incoming.threads) {
      let local = state.draft.comments.find(comment => comment.id === thread.id)
      if (!local) {
        local = { id: thread.id, message_id: makeID('m'), quote: thread.quote, prefix: thread.prefix, suffix: thread.suffix, line: thread.line, text: '', ready: false }
        state.draft.comments.push(local)
      }
      local.messages = thread.messages
      local.submitted = true
      local.resolved = thread.status === 'resolved'
      if (!state.draft.pending && thread.messages.some(message => message.id === local.message_id)) {
        local.text = ''
        local.ready = false
        local.message_id = makeID('m')
      }
    }
  }

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
        conversation: emptyConversation(attachment.session.id),
        sending: false,
        error: '',
        result: null,
        reloadRevision: 0,
        saving: false,
        saveStatus: '',
        activeComment: null,
        editingComment: null
      }
      for (const comment of tabs[tab.id].draft.comments) {
        comment.id ??= makeID('c')
        comment.message_id ??= makeID('m')
        comment.ready ??= true
        comment.messages ??= []
      }
      if (attachment.conversation) mergeConversation(tabs[tab.id], attachment.conversation)
      await persist(tabs[tab.id])
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
    active.value.draft.comments.push({ ...selected.comment, id: makeID('c'), message_id: makeID('m'), ready: false, messages: [] })
    active.value.activeComment = active.value.draft.comments.length - 1
    active.value.editingComment = active.value.activeComment
  }

  function findComment(comment: ReviewComment): void {
    if (!editor.currentFile) return
    selectReviewQuote(editor.currentFile.markdown, comment)
  }

  function finishComment(index: number): void {
    if (!active.value) return
    active.value.draft.comments[index].ready = true
    active.value.editingComment = null
  }
  function editComment(index: number): void {
    if (!active.value) return
    active.value.draft.comments[index].ready = false
    active.value.activeComment = index
    active.value.editingComment = index
  }
  async function resolveComment(index: number, resolved = true): Promise<void> {
    const state = active.value
    const comment = state?.draft.comments[index]
    if (!state || !comment || state.sending || state.draft.pending) return
    try {
      if (comment.submitted && comment.id) {
        mergeConversation(state, await window.electron.ipcRenderer.invoke('mt::review-resolve', state.session.id, comment.id, resolved))
      } else comment.resolved = resolved
      state.activeComment = null
      state.editingComment = null
      await persist(state)
    } catch (error) { state.error = String(error) }
  }
  async function retryDelivery(submissionID: string): Promise<void> {
    const state = active.value
    if (!state || state.sending) return
    state.sending = true
    state.error = ''
    try {
      mergeConversation(state, await window.electron.ipcRenderer.invoke('mt::review-retry', state.session.id, submissionID))
      const receipt = state.conversation.submissions.find(item => item.id === submissionID)
      if (receipt) state.result = { round: receipt.round ?? 0, delivered: receipt.delivered, error: receipt.error }
    } catch (error) { state.error = String(error) } finally { state.sending = false }
  }

  async function send(index?: number): Promise<void> {
    const review = active.value
    const tab = editor.currentFile
    if (!review || !tab || review.sending) return
    review.sending = true
    review.error = ''
    const revision = review.reloadRevision
    try {
      let request = review.draft.pending
      if (!request) {
        const comments = index === undefined
          ? review.draft.comments.filter(comment => comment.ready && !comment.resolved && comment.text.trim())
          : [review.draft.comments[index]].filter(comment => !comment.resolved && comment.text.trim())
        if (index !== undefined && comments.length === 0) throw new Error('Write a comment before sending.')
        const saved = await editor.FILE_SAVE({ waitForResult: true })
        if (saved?.status !== 'saved') throw new Error('File was not saved; review was not sent.')
        if (saved.pathname !== review.session.file) throw new Error('Review file path changed; reopen the review.')
        request = {
          id: review.session.id, mode: index === undefined ? 'batch' : 'inline',
          submission_id: makeID('s'), note_id: makeID('n'), round: review.draft.round,
          comments: JSON.parse(JSON.stringify(comments)),
          note: index === undefined ? review.draft.note : '', baseline: review.baseline
        }
        review.draft.pending = request
        await persist(review)
      }
      const submitted: ReviewSendRequest = JSON.parse(JSON.stringify(request))
      const response = await window.electron.ipcRenderer.invoke('mt::review-send', submitted)
      review.result = response.result
      // An agent may finish and reload the document before the HTTP reply arrives.
      if (review.reloadRevision === revision) review.baseline = response.saved
      for (const sent of submitted.comments) {
        const comment = review.draft.comments.find(item => item.id === sent.id)
        if (!comment) continue
        comment.messages ??= []
        if (!comment.messages.some(message => message.id === sent.message_id)) {
          comment.messages.push({ id: sent.message_id ?? makeID('m'), role: 'user', text: sent.text, created_at: new Date().toISOString() })
        }
        comment.submitted = true
        if (comment.message_id === sent.message_id) {
          if (comment.text === sent.text) comment.text = ''
          comment.message_id = makeID('m')
          comment.ready = false
        }
      }
      if (submitted.mode !== 'inline') {
        if (review.draft.note === submitted.note) review.draft.note = ''
        review.draft.round = Math.max(review.draft.round, submitted.round + 1)
      }
      review.draft.pending = undefined
      if (response.conversation) mergeConversation(review, response.conversation)
      if (review.editingComment !== null && submitted.comments.some(comment => comment.id === review.draft.comments[review.editingComment ?? -1]?.id)) {
        review.editingComment = null
      }
      review.saveStatus = ''
      await persist(review)
    } catch (error) {
      review.error = String(error)
    } finally {
      review.sending = false
    }
  }

  function initialize(): () => void {
    const stopClosedTabWatch = watch(() => editor.tabs.map(tab => tab.id), ids => {
      for (const id of Object.keys(tabs)) {
        if (!ids.includes(id)) {
          void window.electron.ipcRenderer.invoke('mt::review-detach', tabs[id].session.id)
          delete tabs[id]
        }
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
    const stopStateListener = window.electron.ipcRenderer.on('mt::review-state-changed', (_event, state) => {
      for (const review of Object.values(tabs)) {
        if (review.session.id === state.id) mergeConversation(review, state)
      }
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
      stopStateListener()
      for (const state of Object.values(tabs)) void window.electron.ipcRenderer.invoke('mt::review-detach', state.session.id)
      stopCommentListener()
      stopSaveListener()
      document.removeEventListener('keydown', onKey, true)
      bus.off('review-baseline', onReload)
    }
  }

  return { tabs, active, addComment, findComment, save, send, finishComment, editComment, resolveComment, retryDelivery, initialize }
})
