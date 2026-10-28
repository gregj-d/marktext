import { computed, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { MIN_EDITOR_WIDTH } from '@/util/editorLayout'

const STORAGE_KEY = 'review-pane-width'
const MIN_WIDTH = 260
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 320

export function useReviewPaneWidth(rail: Ref<HTMLElement | null>) {
  const stored = Number(localStorage.getItem(STORAGE_KEY))
  const preferredWidth = ref(Number.isFinite(stored) && stored > 0
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stored))
    : DEFAULT_WIDTH)
  const availableWidth = ref(window.innerWidth)
  const outlineWidth = ref(0)
  const maximumWidth = computed(() => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, availableWidth.value - outlineWidth.value - MIN_EDITOR_WIDTH)))
  const width = computed(() => Math.min(preferredWidth.value, maximumWidth.value))
  const resizing = ref(false)
  let drag: { x: number; width: number; pointer: number } | undefined
  let observer: ResizeObserver | undefined

  function setWidth(value: number): void {
    preferredWidth.value = Math.max(MIN_WIDTH, Math.min(maximumWidth.value, Math.round(value)))
  }
  function persist(): void {
    localStorage.setItem(STORAGE_KEY, String(preferredWidth.value))
  }
  function startResize(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return
    drag = { x: event.clientX, width: width.value, pointer: event.pointerId }
    resizing.value = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function resize(event: PointerEvent): void {
    if (!drag || drag.pointer !== event.pointerId) return
    setWidth(drag.width + drag.x - event.clientX)
  }
  function finishResize(): void {
    if (!drag) return
    drag = undefined
    resizing.value = false
    persist()
  }
  function resetWidth(): void {
    setWidth(DEFAULT_WIDTH)
    persist()
  }
  function resizeWithKeyboard(event: KeyboardEvent): void {
    const step = event.shiftKey ? 50 : 10
    if (event.key === 'ArrowLeft') setWidth(width.value + step)
    else if (event.key === 'ArrowRight') setWidth(width.value - step)
    else if (event.key === 'Home') setWidth(MIN_WIDTH)
    else if (event.key === 'End') setWidth(maximumWidth.value)
    else return
    event.preventDefault()
    event.stopPropagation()
    persist()
  }

  onMounted(() => {
    const viewport = rail.value?.closest<HTMLElement>('.review-workspace')
    if (!viewport) return
    const outline = viewport.querySelector<HTMLElement>('.document-outline')
    const measure = () => {
      availableWidth.value = viewport.clientWidth
      outlineWidth.value = outline?.classList.contains('is-expanded') ? outline.getBoundingClientRect().width : 0
    }
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(viewport)
    if (outline) observer.observe(outline)
  })
  onBeforeUnmount(() => {
    finishResize()
    observer?.disconnect()
  })

  return { width, minimumWidth: MIN_WIDTH, maximumWidth, resizing, startResize, resize, finishResize, resizeWithKeyboard, resetWidth }
}
