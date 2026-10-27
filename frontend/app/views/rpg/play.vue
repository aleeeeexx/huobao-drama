<template>
  <div class="play">
    <aside class="dossier">
      <button class="back" type="button" @click="navigateTo('/')">← 世界</button>
      <p class="eyebrow">{{ session?.world?.genre || '织界' }}</p>
      <h1>{{ session?.title || '织界' }}</h1>
      <p v-if="session?.world?.tagline" class="tagline">{{ session.world.tagline }}</p>

      <section class="block">
        <h2>此刻</h2>
        <p class="scene-name">{{ state.scene.location || '尚未开场' }}</p>
        <p class="dim">{{ state.scene.time }}</p>
        <p v-if="state.scene.summary" class="scene-summary">{{ state.scene.summary }}</p>
      </section>

      <div class="media-actions">
        <button class="btn" type="button" :disabled="!latest || mediaBusy === 'image'" @click="illustrate">
          {{ imageLabel }}
        </button>
        <button class="btn" type="button" :disabled="!latest || mediaBusy === 'video'" @click="film">
          {{ videoLabel }}
        </button>
      </div>
      <p v-if="latest?.image_error || latest?.video_error" class="media-error">{{ latest.image_error || latest.video_error }}</p>
      <figure v-if="latest?.image_url" class="still">
        <button
          ref="stillOpenButton"
          type="button"
          class="still-open"
          :aria-expanded="stillOpen"
          aria-haspopup="dialog"
          @click="openStill"
        >
          <img :src="latest.image_url" alt="这一幕的剧情图" />
        </button>
      </figure>
      <video v-if="latest?.video_url" class="clip" controls :src="latest.video_url"></video>

      <section class="block">
        <h2>人物</h2>
        <ul v-if="state.characters.length">
          <li v-for="person in state.characters" :key="person.name">
            <strong>{{ person.name }}</strong>
            <span>{{ person.role }}</span>
            <em>{{ person.status }}</em>
          </li>
        </ul>
        <p v-else class="dim">还没有人走进这一幕。</p>
      </section>

      <section class="block">
        <h2>物品</h2>
        <ul v-if="state.items.length">
          <li v-for="item in state.items" :key="item.name">
            <strong>{{ item.name }}</strong>
            <span>{{ item.holder }}</span>
            <em>{{ item.description }}</em>
          </li>
        </ul>
        <p v-else class="dim">身上还是空的。</p>
      </section>

      <section class="block">
        <h2>事务</h2>
        <ul v-if="state.quests.length">
          <li v-for="quest in state.quests" :key="quest.title">
            <strong>{{ quest.title }}</strong>
            <span class="quest" :data-status="quest.status">{{ questLabel(quest.status) }}</span>
            <em>{{ quest.detail }}</em>
          </li>
        </ul>
        <p v-else class="dim">还没有明确要办的事。</p>
      </section>

      <NuxtLink v-if="session?.drama_id" class="studio-link" :to="`/drama/${session.drama_id}/episode/1`">在制作台打开这一集</NuxtLink>
    </aside>

    <section class="stage">
      <div ref="logEl" class="log">
      <p v-if="loading" class="waiting">正在推开这一局…</p>
      <article v-for="turn in session?.turns || []" :key="turn.id" class="turn">
        <p v-if="turn.player_mode === 'choice'" class="player-line">你选择了：{{ turn.player_text }}</p>
        <p v-else-if="turn.player_mode === 'free'" class="player-line">你写下：{{ turn.player_text }}</p>
        <p class="narrative">{{ turn.narrative }}</p>
      </article>
      <article v-if="acting" class="turn live">
        <p v-if="pendingAction" class="player-line">{{ pendingAction }}</p>
        <p class="narrative">{{ draft }}<span class="caret"></span></p>
      </article>
      </div>

      <form v-if="latest && !loading" class="dock" @submit.prevent="sendFree">
        <div class="choices">
          <button
            v-for="choice in choices"
            :key="choice.id"
            class="choice"
            type="button"
            :disabled="acting"
            @click="choose(choice)"
          >
            <strong>{{ choice.label }}</strong>
            <span v-if="choice.detail">{{ choice.detail }}</span>
          </button>
        </div>
        <label class="free">
          <span class="field-label">或者写下你的行动</span>
          <div class="free-row">
            <textarea
              v-model="freeText"
              rows="2"
              maxlength="400"
              placeholder="我把茶券翻过来，对着灯看水印。"
              :disabled="acting"
            ></textarea>
            <button class="btn btn-primary" type="submit" :disabled="acting || !freeText.trim()">就这么做</button>
          </div>
        </label>
      </form>
    </section>

    <Teleport to="body">
      <div
        v-if="stillOpen && latest?.image_url"
        class="overlay still-viewer"
        role="dialog"
        aria-modal="true"
        aria-label="这一幕的剧情图"
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
        <img class="still-viewer-img" :src="latest.image_url" alt="这一幕的剧情图" />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { rpgAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { shareOpening } from '~/utils/rpg-opening'

const route = useRoute()
const sessionId = computed(() => Number(route.params.sessionId))
const session = ref<any>(null)
const loading = ref(true)
const acting = ref(false)
const draft = ref('')
const freeText = ref('')
const pendingAction = ref('')
const mediaBusy = ref('')
const logEl = ref<HTMLElement | null>(null)
const stillOpen = ref(false)
const stillOpenButton = ref<HTMLButtonElement | null>(null)
const stillCloseButton = ref<HTMLButtonElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null

useHead(() => ({ title: session.value?.title ? `${session.value.title} · 织界` : '织界' }))

const latest = computed(() => {
  const turns = session.value?.turns || []
  return turns[turns.length - 1] || null
})
const choices = computed(() => latest.value?.choices || [])
const state = computed(() => latest.value?.world_state || session.value?.world_state || {
  scene: { location: '', time: '', summary: '', atmosphere: '' },
  characters: [],
  items: [],
  quests: [],
})
const imageLabel = computed(() => {
  if (mediaBusy.value === 'image' || latest.value?.image_status === 'processing') return '剧情图绘制中'
  return latest.value?.image_url ? '重画这一幕' : '生成剧情图'
})
const videoLabel = computed(() => {
  if (mediaBusy.value === 'video' || latest.value?.video_status === 'processing') return '影像拍摄中'
  return latest.value?.video_url ? '重拍这一幕' : '生成影像'
})

function questLabel(status: string) {
  if (status === 'done') return '完成'
  if (status === 'failed') return '失败'
  return '进行中'
}

async function load() {
  session.value = await rpgAPI.session(sessionId.value)
}

function needsMediaPoll() {
  const turn = latest.value
  return !!turn && (turn.image_status === 'processing' || turn.video_status === 'processing')
}

function startPoll() {
  stopPoll()
  pollTimer = setInterval(async () => {
    try {
      await load()
      if (!needsMediaPoll()) stopPoll()
    } catch { /* 下一轮再问 */ }
  }, 3000)
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

async function scrollLog() {
  await nextTick()
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
}

watch(draft, scrollLog)

async function act(body: { mode: string; choice_id?: string; text?: string }) {
  if (acting.value) return
  acting.value = true
  draft.value = ''
  if (body.mode === 'choice') {
    const choice = choices.value.find((item: { id: string; label: string }) => item.id === body.choice_id)
    pendingAction.value = choice ? `你选择了：${choice.label}` : ''
  } else if (body.mode === 'free') {
    pendingAction.value = `你写下：${body.text}`
  } else {
    pendingAction.value = ''
  }
  try {
    const response = await fetch(`/api/v1/rpg/sessions/${sessionId.value}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.message || '这一幕没有写完')
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
        if (event.event === 'delta') draft.value += event.data.text || ''
        if (event.event === 'error') failure = event.data.message || '这一幕没有写完'
      }
    }
    const tail = parseSse(buffer)
    if (tail?.event === 'delta') draft.value += tail.data.text || ''
    if (tail?.event === 'error') failure = tail.data.message || failure
    if (failure) throw new Error(failure)
    draft.value = ''
    pendingAction.value = ''
    freeText.value = ''
    await load()
    await scrollLog()
  } catch (error) {
    toastError(error, { fallback: '这一幕没有写完' })
    await load().catch(() => {})
  } finally {
    acting.value = false
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

function choose(choice: { id: string }) {
  return act({ mode: 'choice', choice_id: choice.id })
}

function sendFree() {
  const text = freeText.value.trim()
  if (!text) return
  return act({ mode: 'free', text })
}

function openStill() {
  if (!latest.value?.image_url) return
  stillOpen.value = true
}

function closeStill() {
  if (!stillOpen.value) return
  stillOpen.value = false
  nextTick(() => stillOpenButton.value?.focus())
}

function onStillViewerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeStill()
}

watch(stillOpen, async (open) => {
  if (!open) {
    window.removeEventListener('keydown', onStillViewerKeydown)
    return
  }
  window.addEventListener('keydown', onStillViewerKeydown)
  await nextTick()
  stillCloseButton.value?.focus()
})

watch(sessionId, () => {
  stillOpen.value = false
})

async function illustrate() {
  mediaBusy.value = 'image'
  try {
    await rpgAPI.illustrate(sessionId.value)
    toast('正在对照定妆和场景图画这一幕')
    await load()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '剧情图没有画出来' })
  } finally {
    mediaBusy.value = ''
  }
}

async function film() {
  mediaBusy.value = 'video'
  try {
    await rpgAPI.film(sessionId.value)
    toast('正在拍这一幕，通常要几分钟')
    await load()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '影像没有拍出来' })
  } finally {
    mediaBusy.value = ''
  }
}

onMounted(async () => {
  try {
    await load()
    if (!session.value?.turns?.length) {
      await shareOpening(sessionId.value, () => act({ mode: 'opening' }))
      if (!session.value?.turns?.length) await load()
    } else if (needsMediaPoll()) startPoll()
  } catch (error) {
    toastError(error, { fallback: '这一局没有打开' })
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
.play {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  background:
    radial-gradient(1200px 400px at 70% -10%, var(--accent-bg), transparent 60%),
    var(--surface-base);
}
.dossier, .stage { min-height: 0; min-width: 0; }
.stage { display: flex; flex-direction: column; overflow: hidden; }
.log { flex: 1; min-height: 0; overflow: auto; padding: 28px 8vw 16px; display: flex; flex-direction: column; gap: 22px; }
.dossier {
  padding: 22px 20px 28px;
  border-right: 1px solid var(--border);
  background: var(--surface-raised);
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow: auto;
}
.back, .studio-link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text-2);
  cursor: pointer;
  text-decoration: none;
  font-size: 13px;
  width: fit-content;
}
.back:hover, .studio-link:hover { color: var(--accent-text); }
.eyebrow { font-size: 11px; letter-spacing: 0.14em; color: var(--accent-text); font-weight: 700; }
.dossier h1, .scene-name {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
}
.dossier h1 { font-size: 32px; line-height: 1.05; letter-spacing: -0.03em; }
.tagline, .scene-summary, .dim { color: var(--text-2); font-size: 13px; line-height: 1.6; }
.block h2 {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--text-3);
  margin-bottom: 6px;
}
.scene-name { font-size: 22px; }
.block ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
.block li { display: flex; flex-direction: column; gap: 1px; }
.block strong { font-size: 14px; }
.block span, .block em { font-style: normal; color: var(--text-2); font-size: 12px; }
.quest[data-status="done"] { color: var(--success); }
.quest[data-status="failed"] { color: var(--error); }
.media-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.media-error { color: var(--error); font-size: 12px; line-height: 1.5; }
.still, .clip { width: 100%; border-radius: 14px; background: #111; }
.still img, .clip { display: block; width: 100%; max-height: 180px; object-fit: cover; }
.still img { border-radius: 14px; }
.still-open {
  display: block;
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: 14px;
  color: inherit;
  font: inherit;
  line-height: 0;
  cursor: zoom-in;
  appearance: none;
}
.still-open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.overlay.still-viewer {
  --still-viewer-pad-x: 28px;
  --still-viewer-pad-top: 64px;
  --still-viewer-pad-bottom: 28px;
  z-index: 120;
  padding: var(--still-viewer-pad-top) var(--still-viewer-pad-x) var(--still-viewer-pad-bottom);
  overflow: visible;
}
.still-viewer-close {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 1;
  background: var(--surface-raised);
  color: var(--text-0);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-lg);
}
.still-viewer-close:hover {
  background: var(--surface-raised);
  color: var(--text-0);
}
.still-viewer-img {
  display: block;
  flex: 0 1 auto;
  width: auto;
  height: auto;
  min-width: 0;
  min-height: 0;
  max-width: calc(100vw - (var(--still-viewer-pad-x) * 2));
  max-height: calc(100vh - var(--still-viewer-pad-top) - var(--still-viewer-pad-bottom));
  max-height: calc(100dvh - var(--still-viewer-pad-top) - var(--still-viewer-pad-bottom));
  object-fit: contain;
  object-position: center;
  border-radius: 14px;
  background: #111;
  box-shadow: var(--shadow-xl);
}
.waiting { color: var(--text-3); }
.turn { max-width: 720px; }
.player-line { color: var(--accent-text); font-size: 13px; margin-bottom: 8px; }
.narrative {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
  font-size: 19px;
  line-height: 1.85;
  white-space: pre-wrap;
}
.caret {
  display: inline-block;
  width: 0.55em;
  height: 1em;
  margin-left: 2px;
  background: var(--accent);
  vertical-align: text-bottom;
  animation: blink 1s steps(1) infinite;
}
.dock {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-raised) 92%, transparent);
  padding: 12px 8vw 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; max-width: 920px; }
.choice {
  text-align: left;
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: inherit;
}
.choice strong { font-size: 15px; }
.choice span { color: var(--text-2); font-size: 12px; }
.choice:hover:not(:disabled) { border-color: var(--accent); }
.choice:disabled, .free textarea:disabled { opacity: 0.6; cursor: default; }
.free { display: flex; flex-direction: column; gap: 6px; max-width: 920px; }
.field-label { font-size: 12px; font-weight: 650; color: var(--text-2); }
.free-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
.free textarea {
  width: 100%;
  resize: vertical;
  min-height: 64px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface-input);
  color: var(--text-0);
  padding: 10px 12px;
  font: inherit;
  line-height: 1.5;
}
@keyframes blink { 50% { opacity: 0; } }
@media (max-width: 860px) {
  .play { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .dossier { max-height: 46vh; border-right: 0; border-bottom: 1px solid var(--border); }
  .log { padding: 18px 16px 12px; }
  .dock { padding: 10px 16px 14px; }
  .choices { grid-template-columns: 1fr; }
  .free textarea { min-height: 44px; }
  .free-row { grid-template-columns: 1fr; }
}
</style>
