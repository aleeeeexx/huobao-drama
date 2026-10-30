<template>
  <div class="read">
    <aside class="dossier">
      <button class="back" type="button" @click="navigateTo('/novel')">← 书库</button>
      <p class="eyebrow">{{ book?.genre || '小说' }}</p>
      <h1>{{ book?.title || '小说' }}</h1>
      <p v-if="book?.topic" class="topic">{{ book.topic }}</p>
      <p class="dim">已写 {{ writtenCount }} / {{ book?.number_of_chapters || 0 }} 章 · 每章约 {{ book?.word_number || 0 }} 字</p>

      <section class="block">
        <h2>角色状态</h2>
        <p v-if="book?.architecture?.character_state" class="prose">{{ book.architecture.character_state }}</p>
        <p v-else class="dim">写第一章时会先生成角色状态。</p>
      </section>

      <details class="block">
        <summary>架构</summary>
        <template v-if="book?.architecture?.generated">
          <h3>核心种子</h3>
          <p class="prose">{{ book.architecture.core_seed }}</p>
          <h3>角色动力学</h3>
          <p class="prose">{{ book.architecture.character_dynamics }}</p>
          <h3>世界观</h3>
          <p class="prose">{{ book.architecture.world_building }}</p>
          <h3>情节架构</h3>
          <p class="prose">{{ book.architecture.plot_architecture }}</p>
        </template>
        <p v-else class="dim">架构还没写。写下一章时会先补上。</p>
      </details>

      <details class="block" open>
        <summary>大纲</summary>
        <ol v-if="book?.outline?.length" class="outline">
          <li v-for="item in book.outline" :key="item.number" :class="{ written: item.written }">
            <strong>第{{ item.number }}章 {{ item.title }}</strong>
            <span v-if="item.summary">{{ item.summary }}</span>
          </li>
        </ol>
        <p v-else class="dim">整本大纲会在第一次写章时生成。</p>
      </details>

      <NuxtLink v-if="book?.drama_id" class="studio-link" :to="`/drama/${book.drama_id}/episode/1`">在制作台打开原稿</NuxtLink>
    </aside>

    <section class="stage">
      <div ref="logEl" class="log">
        <p v-if="loading" class="waiting">正在翻开这本书…</p>
        <p v-else-if="!(book?.chapters || []).length && !writing" class="waiting">
          还没有正文。点下面的「写下一章」，会先写架构和整本大纲，再写第一章。
        </p>
        <article v-for="chapter in book?.chapters || []" :key="chapter.number" class="chapter">
          <h2>第{{ chapter.number }}章 {{ chapter.title }}</h2>
          <p v-if="chapter.note" class="note">本章提示：{{ chapter.note }}</p>
          <p class="narrative">{{ chapter.text }}</p>
          <div class="turn-media">
            <div class="media-actions">
              <button class="btn" type="button" :disabled="imageBusy(chapter)" @click="illustrate(chapter)">
                {{ imageLabel(chapter) }}
              </button>
              <button class="btn" type="button" :disabled="videoBusy(chapter)" @click="film(chapter)">
                {{ videoLabel(chapter) }}
              </button>
            </div>
            <p v-if="chapter.image_error" class="media-error">{{ chapter.image_error }}</p>
            <p v-if="chapter.video_error" class="media-error">{{ chapter.video_error }}</p>
            <figure v-if="chapter.image_url" class="still">
              <button
                type="button"
                class="still-open"
                :aria-expanded="viewer?.key === 'chapter-' + chapter.number"
                aria-haspopup="dialog"
                @click="openStill($event, chapter.image_url, '这一章的剧情图', 'chapter-' + chapter.number)"
              >
                <img :src="chapter.image_url" alt="这一章的剧情图" />
              </button>
            </figure>
            <video v-if="chapter.video_url" class="clip" controls :src="chapter.video_url"></video>
          </div>
        </article>
        <p v-if="writing" class="waiting" role="status">{{ phaseLabel }}<span class="caret" aria-hidden="true"></span></p>
      </div>

      <form v-if="book && !finished" class="dock" @submit.prevent="writeNext">
        <label class="note-field">
          <span class="field-label">本章提示</span>
          <textarea
            v-model="chapterNote"
            rows="2"
            maxlength="500"
            placeholder="可留空。只作为这一章的用户指导，不改提示词。"
            :disabled="writing"
          ></textarea>
        </label>
        <button class="btn btn-primary" type="submit" :disabled="writing">写下一章</button>
      </form>
      <p v-else-if="finished" class="finished">这本书的章节已经写完。</p>
    </section>

    <Teleport to="body">
      <div
        v-if="viewer"
        class="overlay still-viewer"
        role="dialog"
        aria-modal="true"
        :aria-label="viewer.alt"
        @click.self="closeStill"
      >
        <button
          ref="stillCloseButton"
          type="button"
          class="btn btn-ghost btn-icon still-viewer-close"
          aria-label="关闭"
          @click="closeStill"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <img class="still-viewer-img" :src="viewer.src" :alt="viewer.alt" />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { novelAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const PHASE_LABELS: Record<string, string> = {
  architecture: '正在生成小说架构',
  blueprint: '正在生成整本大纲',
  draft: '正在写这一章',
  enrich: '正在扩写这一章',
  finalize: '正在定稿',
}

const route = useRoute()
const bookId = computed(() => Number(route.params.bookId))
const book = ref<any>(null)
const loading = ref(true)
const writing = ref(false)
const phase = ref('')
const chapterNote = ref('')
const mediaBusy = ref<Record<string, true>>({})
const logEl = ref<HTMLElement | null>(null)
const viewer = ref<{ src: string; alt: string; key: string } | null>(null)
const viewerOpener = ref<HTMLButtonElement | null>(null)
const stillCloseButton = ref<HTMLButtonElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

useHead(() => ({ title: book.value?.title ? `${book.value.title} · 小说` : '小说创作' }))

const writtenCount = computed(() => (book.value?.chapters || []).length)
const finished = computed(() => {
  const total = book.value?.number_of_chapters || 0
  return total > 0 && writtenCount.value >= total
})
const phaseLabel = computed(() => PHASE_LABELS[phase.value] || '正在写这一章')

function busyKey(chapterNumber: number, kind: 'image' | 'video') {
  return `${chapterNumber}:${kind}`
}

function imageBusy(chapter: { number: number; image_status?: string | null }) {
  return !!mediaBusy.value[busyKey(chapter.number, 'image')] || chapter.image_status === 'processing'
}

function videoBusy(chapter: { number: number; video_status?: string | null }) {
  return !!mediaBusy.value[busyKey(chapter.number, 'video')] || chapter.video_status === 'processing'
}

function imageLabel(chapter: { number: number; image_url?: string | null; image_status?: string | null }) {
  if (imageBusy(chapter)) return '剧情图绘制中'
  return chapter.image_url ? '重画这一章' : '生成剧情图'
}

function videoLabel(chapter: { number: number; video_url?: string | null; video_status?: string | null }) {
  if (videoBusy(chapter)) return '剧情视频拍摄中'
  return chapter.video_url ? '重拍这一章' : '生成剧情视频'
}

async function load() {
  book.value = await novelAPI.book(bookId.value)
}

function needsPoll() {
  return (book.value?.chapters || []).some((chapter: { image_status?: string | null; video_status?: string | null }) => (
    chapter.image_status === 'processing' || chapter.video_status === 'processing'
  ))
}

function startPoll() {
  stopPoll()
  if (!needsPoll()) return
  pollTimer = setInterval(async () => {
    try {
      await load()
      if (!needsPoll()) stopPoll()
    } catch { /* 下一轮再问 */ }
  }, 3000)
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

async function scrollLog() {
  await nextTick()
  const log = logEl.value
  if (log) log.scrollTop = log.scrollHeight
}

async function writeNext() {
  if (writing.value || finished.value) return
  writing.value = true
  phase.value = 'architecture'
  await scrollLog()
  try {
    const response = await fetch(`/api/v1/novel/books/${bookId.value}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guidance: chapterNote.value.trim() }),
    })
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.message || '这一章没有写完')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failure = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const event = parseSse(block)
        if (!event) continue
        if (event.event === 'phase' && event.data.phase) phase.value = event.data.phase
        if (event.event === 'error') failure = event.data.message || '这一章没有写完'
        if (event.event === 'done' && event.data.book) book.value = event.data.book
      }
    }
    const tail = parseSse(buffer)
    if (tail?.event === 'phase' && tail.data.phase) phase.value = tail.data.phase
    if (tail?.event === 'error') failure = tail.data.message || failure
    if (tail?.event === 'done' && tail.data.book) book.value = tail.data.book
    if (failure) throw new Error(failure)
    chapterNote.value = ''
    if (!book.value?.chapters?.length) await load()
    await scrollLog()
  } catch (error) {
    toastError(error, { fallback: '这一章没有写完' })
    try { await load() } catch { /* 页面上保留已写下的部分 */ }
  } finally {
    writing.value = false
    phase.value = ''
  }
}

function parseSse(block: string) {
  if (!block.trim()) return null
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

function markBusy(chapterNumber: number, kind: 'image' | 'video', active: boolean) {
  const key = busyKey(chapterNumber, kind)
  const next = { ...mediaBusy.value }
  if (active) next[key] = true
  else delete next[key]
  mediaBusy.value = next
}

async function illustrate(chapter: { number: number; image_url?: string | null; image_status?: string | null }) {
  if (imageBusy(chapter)) return
  markBusy(chapter.number, 'image', true)
  try {
    await novelAPI.illustrate(bookId.value, chapter.number, chapter.image_url ? { force: true } : {})
    toast('正在画这一章的剧情图')
    await load()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '剧情图没有画出来' })
  } finally {
    markBusy(chapter.number, 'image', false)
  }
}

async function film(chapter: { number: number; video_status?: string | null }) {
  if (videoBusy(chapter)) return
  markBusy(chapter.number, 'video', true)
  try {
    await novelAPI.film(bookId.value, chapter.number)
    toast('正在拍这一章的剧情视频')
    await load()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '剧情视频没有拍出来' })
  } finally {
    markBusy(chapter.number, 'video', false)
  }
}

function openStill(event: MouseEvent, src: string, alt: string, key: string) {
  if (!src) return
  viewerOpener.value = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null
  viewer.value = { src, alt, key }
}

function closeStill() {
  if (!viewer.value) return
  const opener = viewerOpener.value
  viewer.value = null
  viewerOpener.value = null
  nextTick(() => opener?.focus())
}

function onStillViewerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeStill()
}

watch(() => !!viewer.value, async (open) => {
  if (!open) {
    window.removeEventListener('keydown', onStillViewerKeydown)
    return
  }
  window.addEventListener('keydown', onStillViewerKeydown)
  await nextTick()
  stillCloseButton.value?.focus()
})

onMounted(async () => {
  try {
    await load()
    if (needsPoll()) startPoll()
  } catch (error) {
    toastError(error, { fallback: '这本书没有打开' })
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  stopPoll()
  window.removeEventListener('keydown', onStillViewerKeydown)
})
</script>

<style scoped>
.read {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  background:
    radial-gradient(1200px 400px at 70% -10%, var(--accent-bg), transparent 60%),
    var(--surface-base);
}
.dossier, .stage { min-height: 0; min-width: 0; }
.dossier {
  overflow: auto;
  padding: 22px 20px 28px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.stage { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.log { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 28px 8vw 32px; display: flex; flex-direction: column; gap: 28px; }
.back {
  align-self: flex-start;
  border: 0;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  padding: 0;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent-text);
  font-weight: 700;
}
h1, h2, .chapter h2 {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
  letter-spacing: -0.02em;
}
h1 { font-size: 32px; line-height: 1.15; margin: 0; }
.topic, .prose, .narrative { white-space: pre-wrap; line-height: 1.75; color: var(--text-1); }
.topic { font-size: 13px; color: var(--text-2); }
.block { display: flex; flex-direction: column; gap: 8px; }
.block h2, .block summary { font-size: 16px; }
.block h3 { font-size: 13px; margin: 8px 0 0; color: var(--text-2); }
.prose, .outline span { font-size: 13px; }
.outline { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
.outline li { color: var(--text-2); }
.outline li.written strong { color: var(--text-0); }
.outline strong, .outline span { display: block; }
.studio-link { color: var(--accent-text); font-size: 13px; }
.chapter h2 { font-size: 28px; margin: 0 0 10px; }
.note { color: var(--text-2); font-size: 13px; }
.narrative { font-size: 16px; }
.turn-media { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.media-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.media-error { color: var(--danger, #b42318); font-size: 13px; }
.still-open { border: 0; padding: 0; background: transparent; cursor: zoom-in; }
.still img, .still-open img { width: min(100%, 720px); border-radius: 16px; display: block; }
.clip { width: min(100%, 720px); border-radius: 16px; background: #000; }
.waiting { color: var(--text-2); }
.caret { display: inline-block; width: 0.5em; }
.dock, .finished {
  border-top: 1px solid var(--border);
  padding: 14px 8vw 18px;
  display: flex;
  gap: 12px;
  align-items: flex-end;
}
.note-field { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 650; color: var(--text-2); }
textarea {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  line-height: 1.6;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface-raised);
  color: inherit;
}
.finished { color: var(--text-2); }
.still-viewer {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
}
.still-viewer-img { max-width: min(1100px, 100%); max-height: 100%; border-radius: 12px; }
.still-viewer-close { position: absolute; top: 16px; right: 16px; }
@media (max-width: 980px) {
  .read { grid-template-columns: 1fr; overflow: auto; }
  .dossier { border-right: 0; border-bottom: 1px solid var(--border); }
  .stage { height: auto; overflow: visible; }
  .log { overflow: visible; }
}
</style>
