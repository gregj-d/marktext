<template>
  <aside
    v-if="review.active"
    id="review-comments-pane"
    ref="rail"
    class="review-rail"
    :class="{ 'is-resizing': resizing }"
    :style="{ '--review-pane-width': `${width}px` }"
    aria-label="Review"
  >
    <div
      class="review-resizer"
      role="separator"
      tabindex="0"
      aria-label="Resize comments pane"
      aria-controls="review-comments-pane"
      aria-orientation="vertical"
      :aria-valuemin="minimumWidth"
      :aria-valuemax="maximumWidth"
      :aria-valuenow="width"
      title="Drag to resize comments; double-click to reset"
      @pointerdown.prevent="startResize"
      @pointermove="resize"
      @pointerup="finishResize"
      @pointercancel="finishResize"
      @lostpointercapture="finishResize"
      @keydown="resizeWithKeyboard"
      @dblclick="resetWidth"
    />
    <header class="review-header">
      <h2>Review</h2>
      <button
        v-if="review.active.draft.comments.some(comment => comment.resolved)"
        class="review-archive-toggle"
        type="button"
        @click="showResolved = !showResolved"
      >
        {{ showResolved ? 'Hide resolved' : 'Show resolved' }}
      </button>
    </header>
    <div class="review-comments">
      <template
        v-for="(comment, index) in review.active.draft.comments"
        :key="comment.id"
      >
        <article
          v-if="!comment.resolved || showResolved"
          class="review-card"
          :class="{ active: review.active.activeComment === index, detached: detached.includes(index), editing: review.active.editingComment === index, resolved: comment.resolved }"
          :data-comment="index"
          tabindex="0"
          aria-label="Review comment"
          @click="cardClick($event, index)"
          @keydown.enter.self.prevent="focusText(index)"
          @focusin="activate(index)"
        >
          <span
            v-if="detached.includes(index)"
            class="review-detached"
            aria-label="Detached comment"
          >Text no longer found</span>
          <div
            v-for="message in comment.messages"
            :key="message.id"
            class="review-message"
            :class="{ 'review-agent-reply': message.role === 'agent' }"
          >
            <span class="review-message-author">{{ message.role === 'agent' ? 'Agent' : 'You' }}</span>
            <p>{{ message.text }}</p>
            <span
              v-if="message.outcome && message.outcome !== 'addressed'"
              class="review-message-outcome"
            >{{ message.outcome === 'blocked' ? 'Blocked' : 'Needs clarification' }}</span>
          </div>
          <textarea
            v-if="review.active.editingComment === index"
            v-model="comment.text"
            aria-label="Comment"
            rows="3"
            :disabled="review.active.sending"
            :placeholder="comment.submitted ? 'Reply…' : 'Add your comment…'"
            @keydown="commentKeydown($event, index)"
          />
          <p
            v-else-if="comment.text || !comment.submitted"
            class="review-comment-text"
          >
            {{ comment.text || 'Empty comment' }}
          </p>
          <span
            v-if="awaitingReply(comment)"
            class="review-awaiting"
          >Awaiting reply</span>
          <div class="review-card-actions">
            <button
              v-if="comment.resolved"
              type="button"
              :disabled="review.active.sending || !!review.active.draft.pending"
              @click="review.resolveComment(index, false)"
            >
              Reopen
            </button>
            <template v-else>
              <button
                v-if="review.active.editingComment === index"
                type="button"
                @click="finishEditing(index)"
              >
                Done
              </button>
              <button
                v-else
                type="button"
                :aria-label="comment.submitted ? 'Reply' : 'Edit'"
                :title="comment.submitted ? 'Reply to comment' : 'Edit comment'"
                :disabled="review.active.sending || !!review.active.draft.pending"
                @click="edit(index)"
              >
                <EditIcon aria-hidden="true" />
              </button>
              <button
                v-if="comment.text.trim()"
                type="button"
                :disabled="review.active.sending || !!review.active.draft.pending"
                @click="review.send(index)"
              >
                Send
              </button>
              <button
                type="button"
                aria-label="Resolve"
                title="Resolve comment"
                :disabled="review.active.sending || !!review.active.draft.pending"
                @click="review.resolveComment(index)"
              >
                <Check aria-hidden="true" />
              </button>
            </template>
          </div>
        </article>
      </template>
      <section
        v-for="batch in review.active.conversation.rounds"
        :key="batch.round"
        class="review-batch"
        :aria-label="`Review ${batch.round} discussion`"
      >
        <h3>Review {{ batch.round }}</h3>
        <div
          v-for="message in batch.messages.filter(message => message.text)"
          :key="message.id"
          class="review-message"
          :class="{ 'review-agent-reply': message.role === 'agent' }"
        >
          <span class="review-message-author">{{ message.role === 'agent' ? 'Agent' : 'Overall note' }}</span>
          <p>{{ message.text }}</p>
        </div>
        <span
          v-if="!batch.messages.some(message => message.role === 'agent')"
          class="review-awaiting"
        >Awaiting overall response</span>
      </section>
    </div>
    <footer class="review-footer">
      <label class="review-note">
        <span class="review-visually-hidden">Overall note</span>
        <textarea
          v-model="review.active.draft.note"
          aria-label="Overall note"
          :rows="noteFocused ? 3 : 1"
          placeholder="Add an overall note…"
          :disabled="review.active.sending"
          @focus="noteFocused = true"
          @blur="noteFocused = false"
        />
      </label>
      <div class="review-actions">
        <button
          v-if="review.active.draft.pending && !review.active.sending"
          type="button"
          :disabled="review.active.sending"
          @click="review.send()"
        >
          Retry send
        </button>
        <button
          type="button"
          :disabled="review.active.sending || review.active.saving || !!review.active.draft.pending"
          @click="review.save()"
        >
          {{ review.active.saving ? 'Saving…' : 'Save' }}
        </button>
        <button
          class="review-send"
          type="button"
          :disabled="review.active.sending || review.active.saving || !!review.active.draft.pending"
          @click="review.send()"
        >
          {{ review.active.sending ? 'Sending…' : 'Send Review' }}
        </button>
      </div>
      <p
        class="review-status"
        :class="{ 'review-error': hasError }"
        role="status"
      >
        {{ statusText }}
      </p>
      <div
        v-for="submission in review.active.conversation.submissions.filter(item => !item.delivered)"
        :key="submission.id"
        class="review-delivery-error"
      >
        <span>Stored, not delivered. {{ submission.error }}</span>
        <button
          type="button"
          :disabled="review.active.sending"
          @click="review.retryDelivery(submission.id)"
        >
          Retry delivery
        </button>
      </div>
    </footer>
    <teleport to="body">
      <button
        v-if="selection"
        class="review-selection-button"
        type="button"
        aria-label="Add comment"
        :title="`Add comment (${commentShortcut})`"
        :style="selectionStyle"
        @pointerdown.prevent
        @click="addSelection"
      >
        <ChatLineSquare aria-hidden="true" />
      </button>
    </teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChatLineSquare, Edit as EditIcon, Check } from '@element-plus/icons-vue'
import type { ReviewComment } from '@shared/types/review'
import { useReviewStore } from '@/store/review'
import { useReviewAnnotations } from './useReviewAnnotations'
import { useReviewPaneWidth } from './useReviewPaneWidth'

const review = useReviewStore()
const rail = ref<HTMLElement | null>(null)
const { width, minimumWidth, maximumWidth, resizing, startResize, resize, finishResize, resizeWithKeyboard, resetWidth } = useReviewPaneWidth(rail)
const noteFocused = ref(false)
const showResolved = ref(false)
const awaitingReply = (comment: ReviewComment): boolean => {
  const messages = comment.messages ?? []
  return messages.some(message => message.role === 'user' && !messages.some(reply => reply.role === 'agent' && reply.reply_to === message.id))
}
const commentShortcut = /Mac/.test(navigator.platform) ? '⌘⇧M' : 'Ctrl+Shift+M'
const hasError = computed(() => !!(review.active?.error || review.active?.result?.error))
const statusText = computed(() => {
  const state = review.active
  if (!state) return ''
  if (state.error) return state.error
  if (state.sending) return 'Sending review…'
  if (state.saving) return 'Saving…'
  if (state.result?.error) return `${state.result.round ? `Round ${state.result.round}` : 'Comment'}: stored, not delivered. ${state.result.error}`
  if (state.saveStatus) return state.saveStatus
  if (state.result) return `${state.result.round ? `Round ${state.result.round}` : 'Comment'}: ${state.result.delivered ? 'delivered' : 'stored, not delivered'}.`
  return ''
})
const { selection, detached, addSelection, activate, focusText } = useReviewAnnotations()
const selectionStyle = computed(() => selection.value ? {
  left: `${Math.max(8, Math.min(selection.value.rect.right + 8, window.innerWidth - 44))}px`,
  top: `${Math.max(36, Math.min(selection.value.rect.bottom + 6, window.innerHeight - 44))}px`
} : {})

function edit(index: number): void {
  review.editComment(index)
}
function finishEditing(index: number): void {
  if (!review.active) return
  review.finishComment(index)
  nextTick(() => {
    document.querySelector<HTMLElement>(`.review-card[data-comment="${index}"]`)?.focus()
  })
}
function commentKeydown(event: KeyboardEvent, index: number): void {
  if (event.isComposing) return
  if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
    event.preventDefault()
    event.stopPropagation()
    finishEditing(index)
  }
}
function cardClick(event: MouseEvent, index: number): void {
  if ((event.target as HTMLElement).closest('button, textarea')) return
  focusText(index)
}
watch(() => [review.active?.session.id, review.active?.editingComment], () => {
  if (review.active?.editingComment == null) return
  nextTick(() => {
    document.querySelector<HTMLTextAreaElement>(`.review-card[data-comment="${review.active?.editingComment}"] textarea`)?.focus()
  })
})
</script>

<style>
::highlight(sloptown-review) { background-color: var(--themeColor20); }
::highlight(sloptown-review-active) { background-color: var(--highlightColor); text-decoration: underline; }
.review-rail {
  position: relative;
  flex: 0 0 var(--review-pane-width, 320px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  color: var(--sideBarColor);
  background: var(--sideBarBgColor);
  border-left: 1px solid var(--editorColor10);
  font-size: 13px;
  -webkit-app-region: no-drag;
}
.review-header { padding: 18px 20px 12px; }
.review-header h2 { margin: 0; font-size: 13px; font-weight: 600; color: var(--sideBarTitleColor); }
.review-comments { overflow: auto; flex: 1; min-height: 0; padding: 0 12px 12px; }
.review-card {
  position: relative;
  padding: 12px 10px 8px;
  border-bottom: 1px solid var(--editorColor10);
  border-radius: 3px;
  cursor: pointer;
  line-height: 1.6;
}
.review-card.active { background: var(--sideBarItemHoverBgColor); }
.review-card.active::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 2px; background: var(--themeColor); }
.review-card.detached { border-bottom-style: dashed; }
.review-comment-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.review-detached { display: block; color: var(--editorColor60); font-size: 11px; margin-bottom: 6px; }
.review-card-actions, .review-actions { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.review-card-actions { margin-top: 4px; opacity: 0; pointer-events: none; }
.review-card:hover .review-card-actions,
.review-card:focus-within .review-card-actions,
.review-card.editing .review-card-actions { opacity: 1; pointer-events: auto; }
@media (hover: none) { .review-card-actions { opacity: 1; pointer-events: auto; } }
.review-footer { flex-shrink: 0; border-top: 1px solid var(--editorColor10); padding: 12px 16px; }
.review-rail textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  resize: none;
  color: var(--sideBarColor);
  background: var(--editorBgColor);
  border: 1px solid var(--editorColor10);
  border-radius: 4px;
  padding: 8px;
  margin: 0 0 8px;
  font: inherit;
  line-height: 1.6;
}
.review-rail button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--buttonFontColor);
  background: transparent;
  border: 0;
  border-radius: 4px;
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
}
.review-note textarea { background: transparent; }
.review-note textarea:focus { background: var(--editorBgColor); }
.review-rail textarea::placeholder { color: var(--editorColor50); }
.review-rail button:hover { background: var(--sideBarItemHoverBgColor); }
.review-card-actions button { padding: 4px; min-width: 26px; min-height: 26px; font-size: 12px; }
.review-card-actions svg { width: 14px; height: 14px; color: var(--iconColor); }
.review-card.resolved { opacity: 0.65; }
.review-message { margin: 0 0 10px; }
.review-message p { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.review-message-author { font-size: 11px; color: var(--editorColor60); }
.review-agent-reply { border-left: 2px solid var(--themeColor30); padding-left: 10px; }
.review-awaiting, .review-message-outcome { display: block; margin-top: 6px; font-size: 11px; color: var(--editorColor60); }
.review-batch { padding: 12px 10px; border-top: 1px solid var(--editorColor10); }
.review-batch h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; }
.review-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.review-rail .review-archive-toggle { padding: 2px 4px; font-size: 11px; }
.review-delivery-error { font-size: 11px; color: var(--notificationErrorBg); margin-top: 8px; }
.review-rail button:disabled { opacity: 0.5; cursor: default; }
.review-rail .review-send { background: var(--buttonPrimaryBgColor); color: var(--buttonPrimaryFontColor); }
.review-rail .review-send:hover { background: var(--buttonPrimaryBgColorHover); color: var(--buttonPrimaryFontColorHover); }
.review-rail .review-send:active { background: var(--buttonPrimaryBgColorActive); }
.review-rail button:focus-visible,
.review-rail textarea:focus-visible,
.review-card:focus-visible,
.review-selection-button:focus-visible { outline: 2px solid var(--sideBarTitleColor); outline-offset: 2px; }
.review-status { min-height: 16px; color: var(--editorColor60); overflow-wrap: anywhere; font-size: 11px; line-height: 1.5; margin: 8px 0 0; }
.review-status.review-error { color: var(--notificationErrorBg); }
.review-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.review-selection-button {
  position: fixed;
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--floatBorderColor);
  border-radius: 6px;
  color: var(--floatFontColor);
  background: var(--floatBgColor);
  box-shadow: var(--floatShadow);
  cursor: pointer;
}
.review-selection-button svg { width: 20px; height: 20px; }
.review-selection-button:hover { background: var(--floatHoverColor); }
.review-resizer {
  position: absolute;
  inset: 0 auto 0 -4px;
  width: 7px;
  z-index: 6;
  cursor: col-resize;
  touch-action: none;
  -webkit-app-region: no-drag;
}
.review-resizer::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 3px;
  width: 2px;
  background: transparent;
}
.review-resizer:hover::after,
.review-resizer:focus-visible::after,
.review-rail.is-resizing .review-resizer::after { background: var(--iconColor); }
.review-resizer:focus-visible { outline: 2px solid var(--sideBarTitleColor); outline-offset: -2px; }
.review-rail.is-resizing { user-select: none; }
</style>
