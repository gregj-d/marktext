import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useReviewStore } from '@/store/review'
import { useEditorStore } from '@/store/editor'
import {
  indexReviewText, resolveReviewRange, sourceSpanForRange,
  moveReviewSpan, rangeForSourceSpan, type ReviewSourceSpan
} from '@/services/reviewAnchors'
import type { ReviewComment } from '@shared/types/review'
import { captureReviewSelection, clearReviewSelection, reviewEditorRoot, type ReviewSelection } from '@/services/reviewSelection'
const anchors = new WeakMap<ReviewComment, { markdown: string; span: ReviewSourceSpan | null }>()

export function useReviewAnnotations() {
  const review = useReviewStore()
  const editor = useEditorStore()
  const selection = shallowRef<ReviewSelection | null>(null)
  const detached = ref<number[]>([])
  let selectionTab: string | undefined
  let ranges = new Map<number, Range>()
  let frame = 0
  let observer: MutationObserver | undefined

  function refresh(): void {
    frame = 0
    ranges = new Map()
    const root = reviewEditorRoot()
    const markdown = editor.currentFile?.markdown
    const missing: number[] = []
    if (root && markdown !== undefined) {
      const index = indexReviewText(root, markdown)
      review.active?.draft.comments.forEach((comment, position) => {
        if (comment.resolved) return
        let anchor = anchors.get(comment)
        let range: Range | null
        if (anchor) {
          const span = anchor.span ? moveReviewSpan(anchor.markdown, markdown, anchor.span) : null
          anchor = { markdown, span }
          range = span ? rangeForSourceSpan(index, span, comment.quote) : null
        } else {
          range = resolveReviewRange(index, markdown, comment)
          anchor = { markdown, span: range ? sourceSpanForRange(index, range) : null }
        }
        anchors.set(comment, anchor)
        if (range) {
          ranges.set(position, range)
          if (anchor.span) {
            comment.prefix = markdown.slice(Math.max(0, anchor.span.start - 40), anchor.span.start)
            comment.suffix = markdown.slice(anchor.span.end, anchor.span.end + 40)
            comment.line = markdown.slice(0, anchor.span.start).split('\n').length
          }
        } else missing.push(position)
      })
    }
    detached.value = missing
    if (CSS.highlights && typeof Highlight !== 'undefined') {
      CSS.highlights.set('sloptown-review', new Highlight(...ranges.values()))
      const active = ranges.get(review.active?.activeComment ?? -1)
      CSS.highlights.set('sloptown-review-active', new Highlight(...(active ? [active] : [])))
    }
    updateSelection()
  }

  const schedule = (): void => {
    if (!frame) frame = requestAnimationFrame(refresh)
  }

  function updateSelection(): void {
    selection.value = review.active && !review.active.sending ? captureReviewSelection() : null
    if (selection.value && (selection.value.rect.bottom < 36 || selection.value.rect.top > window.innerHeight)) {
      selection.value = null
    }
    selectionTab = editor.currentFile?.id
  }

  function addSelection(): void {
    if (selectionTab !== editor.currentFile?.id || !selection.value) return
    review.addComment(selection.value)
    selection.value = null
  }

  function activate(position: number): void {
    if (!review.active) return
    review.active.activeComment = position
    nextTick(() => document.querySelector(`.review-card[data-comment="${position}"]`)?.scrollIntoView({ block: 'nearest' }))
    schedule()
  }

  function focusText(position: number): void {
    activate(position)
    const range = ranges.get(position)
    if (!range) return
    clearReviewSelection()
    selection.value = null
    document.querySelector<HTMLElement>(`.review-card[data-comment="${position}"]`)?.focus({ preventScroll: true })
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function onClick(event: MouseEvent): void {
    const root = reviewEditorRoot()
    if (!(event.target instanceof Node) || !root?.contains(event.target)) return
    for (const [position, range] of ranges) {
      const hit = [...range.getClientRects()].some(rect =>
        rect.width > 0 && event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom
      )
      if (hit) {
        activate(position)
        return
      }
    }
  }

  const stop = watch(
    () => [editor.currentFile?.id, editor.currentFile?.markdown, review.active?.draft.comments, review.active?.activeComment],
    () => { schedule(); updateSelection() },
    { deep: true, flush: 'post' }
  )
  onMounted(() => {
    observer = new MutationObserver(schedule)
    const body = document.querySelector('.document-body')
    if (body) observer.observe(body, { childList: true, characterData: true, subtree: true })
    document.addEventListener('selectionchange', updateSelection)
    document.addEventListener('pointerup', updateSelection)
    document.addEventListener('keyup', updateSelection)
    document.addEventListener('scroll', updateSelection, true)
    document.addEventListener('pointerdown', onClick, true)
    window.addEventListener('resize', updateSelection)
    schedule()
  })
  onUnmounted(() => {
    stop()
    observer?.disconnect()
    cancelAnimationFrame(frame)
    CSS.highlights?.delete('sloptown-review')
    CSS.highlights?.delete('sloptown-review-active')
    document.removeEventListener('selectionchange', updateSelection)
    document.removeEventListener('pointerup', updateSelection)
    document.removeEventListener('keyup', updateSelection)
    document.removeEventListener('scroll', updateSelection, true)
    document.removeEventListener('pointerdown', onClick, true)
    window.removeEventListener('resize', updateSelection)
  })
  return { selection, detached, addSelection, activate, focusText }
}
