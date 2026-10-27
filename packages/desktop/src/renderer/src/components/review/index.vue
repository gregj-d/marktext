<template>
  <aside
    v-if="review.active"
    class="review-rail"
    aria-label="Review"
  >
    <header class="review-header">
      <h2>Review</h2>
    </header>
    <div class="review-comments">
      <p
        v-if="!review.active.draft.comments.length"
        class="review-empty"
      >
        Select text to leave a comment.
        <span class="review-shortcut">{{ commentShortcut }}</span>
      </p>
      <article
        v-for="(comment, index) in review.active.draft.comments"
        :key="index"
        class="review-card"
        :class="{ active: review.active.activeComment === index, detached: detached.includes(index), editing: review.active.editingComment === index }"
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
        <textarea
          v-if="review.active.editingComment === index"
          v-model="comment.text"
          aria-label="Comment"
          rows="3"
          :disabled="review.active.sending"
          placeholder="Add your comment…"
          @keydown="commentKeydown($event, index)"
        />
        <p
          v-else
          class="review-comment-text"
        >
          {{ comment.text || 'Empty comment' }}
        </p>
        <div class="review-card-actions">
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
            aria-label="Edit"
            title="Edit comment"
            :disabled="review.active.sending"
            @click="edit(index)"
          >
            <EditIcon aria-hidden="true" />
          </button>
          <button
            type="button"
            class="review-delete"
            aria-label="Delete"
            title="Delete comment"
            :disabled="review.active.sending"
            @click="remove(index)"
          >
            <DeleteIcon aria-hidden="true" />
          </button>
        </div>
      </article>
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
          type="button"
          :disabled="review.active.sending || review.active.saving"
          @click="review.save()"
        >
          {{ review.active.saving ? 'Saving…' : 'Save' }}
        </button>
        <button
          class="review-send"
          type="button"
          :disabled="review.active.sending || review.active.saving"
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
import { ChatLineSquare, Edit as EditIcon, Delete as DeleteIcon } from '@element-plus/icons-vue'
import { useReviewStore } from '@/store/review'
import { useReviewAnnotations } from './useReviewAnnotations'

const review = useReviewStore()
const noteFocused = ref(false)
const commentShortcut = /Mac/.test(navigator.platform) ? '⌘⇧M' : 'Ctrl+Shift+M'
const hasError = computed(() => !!(review.active?.error || review.active?.result?.error))
const statusText = computed(() => {
  const state = review.active
  if (!state) return ''
  if (state.error) return state.error
  if (state.sending) return 'Sending review…'
  if (state.saving) return 'Saving…'
  if (state.result?.error) return `Round ${state.result.round}: stored, not delivered. ${state.result.error}`
  if (state.saveStatus) return state.saveStatus
  if (state.result) return `Round ${state.result.round}: ${state.result.delivered ? 'delivered' : 'stored, not delivered'}.`
  return ''
})
const { selection, detached, addSelection, activate, focusText } = useReviewAnnotations()
const selectionStyle = computed(() => selection.value ? {
  left: `${Math.max(8, Math.min(selection.value.rect.right + 8, window.innerWidth - 44))}px`,
  top: `${Math.max(36, Math.min(selection.value.rect.bottom + 6, window.innerHeight - 44))}px`
} : {})

function edit(index: number): void {
  if (!review.active) return
  review.active.activeComment = index
  review.active.editingComment = index
}
function finishEditing(index: number): void {
  if (!review.active) return
  review.active.editingComment = null
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
function remove(index: number): void {
  if (!review.active) return
  review.active.draft.comments.splice(index, 1)
  review.active.activeComment = null
  review.active.editingComment = null
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
  flex: 0 0 clamp(260px, 27vw, 320px);
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
.review-empty { color: var(--editorColor50); line-height: 1.6; margin: 12px 4px; }
.review-shortcut { display: block; margin-top: 8px; font-size: 11px; color: var(--editorColor60); }
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
.review-card-actions .review-delete:hover svg { color: var(--notificationErrorBg); }
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
</style>
