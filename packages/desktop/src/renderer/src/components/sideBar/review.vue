<template>
  <section
    class="review-panel"
    aria-label="Review"
  >
    <header>
      <h2>Review</h2>
      <button
        type="button"
        @click="layout.SET_LAYOUT({ rightColumn: 'files' })"
      >
        Files
      </button>
    </header>
    <template v-if="review.active">
      <p class="review-target">
        {{ review.active.session.thread || 'Main thread' }}
      </p>
      <button
        type="button"
        :disabled="review.active.sending"
        @mousedown.prevent
        @click="review.addComment()"
      >
        Comment on selection <kbd>⌘⇧M</kbd>
      </button>
      <fieldset :disabled="review.active.sending">
        <ol class="review-comments">
          <li
            v-for="(comment, index) in review.active.draft.comments"
            :key="index"
          >
            <button
              class="review-quote"
              type="button"
              @click="review.findComment(comment)"
            >
              “{{ comment.quote }}” <small v-if="comment.line">Line {{ comment.line }}</small>
            </button>
            <label>
              Comment {{ index + 1 }}
              <textarea
                v-model="comment.text"
                :aria-label="`Comment ${index + 1}`"
                rows="3"
              />
            </label>
            <button
              type="button"
              @click="review.active.draft.comments.splice(index, 1)"
            >
              Delete comment
            </button>
          </li>
        </ol>
        <label>
          Overall note
          <textarea
            v-model="review.active.draft.note"
            aria-label="Overall note"
            rows="4"
          />
        </label>
      </fieldset>
      <button
        type="button"
        :disabled="review.active.sending"
        @click="review.send()"
      >
        {{ review.active.sending ? 'Sending…' : 'Send review' }}
      </button>
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
        {{ review.active.error }}
      </p>
    </template>
    <p v-else>
      Open a review from sloptown to attach it to a document.
    </p>
  </section>
</template>

<script setup lang="ts">
import { nextTick, watch } from 'vue'
import { useReviewStore } from '@/store/review'
import { useLayoutStore } from '@/store/layout'

const review = useReviewStore()
const layout = useLayoutStore()

watch(() => review.active?.draft.comments.length, (length, previous) => {
  if (length && length > (previous ?? 0)) {
    nextTick(() => {
      document.querySelector<HTMLTextAreaElement>('.review-comments li:last-child textarea')?.focus()
    })
  }
})
</script>

<style scoped>
.review-panel {
  height: 100%;
  overflow: auto;
  padding: 12px;
  box-sizing: border-box;
  font-size: 13px;
  user-select: text;
}
header { display: flex; align-items: center; justify-content: space-between; }
h2 { font-size: 15px; margin: 0; }
fieldset { border: 0; margin: 12px 0; padding: 0; min-width: 0; }
label { display: block; }
textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  color: var(--sideBarColor);
  background: var(--editorBgColor);
  border: 1px solid var(--itemBgColor);
  border-radius: 4px;
  padding: 6px;
  margin: 6px 0;
  font: inherit;
}
button {
  color: inherit;
  background: var(--itemBgColor);
  border: 0;
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
  font: inherit;
}
button:disabled { opacity: 0.5; cursor: default; }
.review-comments { padding: 0 0 0 20px; }
li { margin-bottom: 16px; }
.review-quote { display: block; text-align: left; overflow-wrap: anywhere; margin-bottom: 6px; }
small { display: block; opacity: 0.7; }
.review-status { overflow-wrap: anywhere; }
kbd { font-size: 11px; opacity: 0.7; }
</style>
