<template>
  <aside
    v-if="review.active"
    class="review-rail"
    aria-label="Review"
  >
    <header class="review-header">
      <h2>Review</h2>
      <span>{{ review.active.session.thread || 'Main thread' }}</span>
    </header>
    <div class="review-comments">
      <p
        v-if="!review.active.draft.comments.length"
        class="review-empty"
      >
        Select text in the document to add a comment.
      </p>
      <article
        v-for="(comment, index) in review.active.draft.comments"
        :key="index"
        class="review-card"
        :class="{ active: review.active.activeComment === index, detached: detached.includes(index) }"
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
            @click="review.active.editingComment = null"
          >
            Done
          </button>
          <button
            v-else
            type="button"
            :disabled="review.active.sending"
            @click="edit(index)"
          >
            Edit
          </button>
          <button
            type="button"
            :disabled="review.active.sending"
            @click="remove(index)"
          >
            Delete
          </button>
        </div>
      </article>
    </div>
    <footer class="review-footer">
      <label>
        Overall note
        <textarea
          v-model="review.active.draft.note"
          aria-label="Overall note"
          rows="3"
          :disabled="review.active.sending"
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
        role="status"
      >
        <template v-if="review.active.result">
          Round {{ review.active.result.round }}:
          {{ review.active.result.delivered ? 'delivered' : 'stored, not delivered' }}.
          {{ review.active.result.error }}
        </template>
        <template v-else>
          Round {{ review.active.draft.round }} ready.
        </template>
        {{ review.active.saveStatus }} {{ review.active.error }}
      </p>
    </footer>
    <teleport to="body">
      <button
        v-if="selection"
        class="review-selection-button"
        type="button"
        aria-label="Add comment"
        title="Add comment (⌘⇧M)"
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
import { computed, nextTick, watch } from 'vue'
import { ChatLineSquare } from '@element-plus/icons-vue'
import { useReviewStore } from '@/store/review'
import { useReviewAnnotations } from './useReviewAnnotations'

const review = useReviewStore()
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
::highlight(sloptown-review) { background-color: #ffd75c66; }
::highlight(sloptown-review-active) { background-color: #ffc533a6; text-decoration: underline; }
.review-rail {
  flex: 0 0 clamp(260px, 27vw, 320px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  color: var(--sideBarColor);
  background: var(--sideBarBgColor);
  border-left: 1px solid var(--itemBgColor);
  font-size: 13px;
  -webkit-app-region: no-drag;
}
.review-header { padding: 16px; border-bottom: 1px solid var(--itemBgColor); }
.review-header h2 { margin: 0 0 4px; font-size: 15px; }
.review-header span, .review-empty, .review-detached { opacity: 0.65; }
.review-comments { overflow: auto; flex: 1; min-height: 0; padding: 12px; }
.review-card {
  padding: 12px;
  margin-bottom: 12px;
  background: var(--editorBgColor);
  border: 1px solid var(--itemBgColor);
  border-radius: 8px;
  cursor: pointer;
}
.review-card.active { border-color: #bd8a14; box-shadow: 0 0 0 1px #bd8a1440; }
.review-card.detached { border-style: dashed; }
.review-comment-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 8px; }
.review-detached { display: block; font-size: 11px; margin-bottom: 8px; }
.review-card-actions, .review-actions { display: flex; gap: 8px; justify-content: flex-end; }
.review-footer { flex-shrink: 0; border-top: 1px solid var(--itemBgColor); padding: 12px 16px; }
.review-rail textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  color: var(--sideBarColor);
  background: var(--editorBgColor);
  border: 1px solid var(--itemBgColor);
  border-radius: 4px;
  padding: 8px;
  margin: 6px 0 10px;
  font: inherit;
}
.review-rail button {
  color: inherit;
  background: var(--itemBgColor);
  border: 0;
  border-radius: 4px;
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
}
.review-rail button:disabled { opacity: 0.5; cursor: default; }
.review-rail .review-send { background: #795b12; color: white; }
.review-status { overflow-wrap: anywhere; font-size: 12px; margin: 10px 0 0; }
.review-selection-button {
  position: fixed;
  z-index: 20000;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 1px solid #bd8a14;
  border-radius: 6px;
  color: #493603;
  background: #fff6d7;
  box-shadow: 0 2px 8px #0002;
  cursor: pointer;
}
.review-selection-button svg { width: 20px; height: 20px; }
</style>
