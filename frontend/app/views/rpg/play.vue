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
        <button
          v-if="currentScenePlate"
          type="button"
          class="plate-open plate-wide"
          :aria-expanded="viewer?.key === 'now-scene-' + currentScenePlate.id"
          aria-haspopup="dialog"
          @click="openStill($event, currentScenePlate.image_url, currentScenePlate.location || '场景', 'now-scene-' + currentScenePlate.id)"
        >
          <img :src="currentScenePlate.image_url" :alt="currentScenePlate.location || '场景'" />
        </button>
      </section>

      <section class="block">
        <h2>人物</h2>
        <ul v-if="people.length">
          <li v-for="person in people" :key="person.name" :class="{ 'with-plate': person.image_url }">
            <button
              v-if="person.image_url"
              type="button"
              class="plate-open plate-portrait"
              :aria-expanded="viewer?.key === 'now-character-' + person.plate_id"
              aria-haspopup="dialog"
              @click="openStill($event, person.image_url, person.name, 'now-character-' + person.plate_id)"
            >
              <img :src="person.image_url" :alt="person.name" />
            </button>
            <div class="who-copy">
              <strong>{{ person.name }}</strong>
              <span>{{ person.role }}</span>
              <em>{{ person.status }}</em>
            </div>
          </li>
        </ul>
        <p v-else class="dim">还没有人走进这一幕。</p>
      </section>

      <section class="block">
        <h2>物品</h2>
        <ul v-if="belongings.length">
          <li v-for="item in belongings" :key="item.name" :class="{ 'with-plate': item.image_url }">
            <button
              v-if="item.image_url"
              type="button"
              class="plate-open plate-portrait"
              :aria-expanded="viewer?.key === 'now-prop-' + item.plate_id"
              aria-haspopup="dialog"
              @click="openStill($event, item.image_url, item.name, 'now-prop-' + item.plate_id)"
            >
              <img :src="item.image_url" :alt="item.name" />
            </button>
            <div class="who-copy">
              <strong>{{ item.name }}</strong>
              <span>{{ item.holder }}</span>
              <em>{{ item.description }}</em>
            </div>
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

      <section class="block">
        <h2>物料</h2>
        <ul v-if="readyPlates.length" class="plate-list">
          <li v-for="plate in readyPlates" :key="plate.key" class="plate-row">
            <button
              type="button"
              class="plate-open"
              :aria-expanded="viewer?.key === plate.key"
              aria-haspopup="dialog"
              @click="openStill($event, plate.image_url, plate.name, plate.key)"
            >
              <img :src="plate.image_url" :alt="plate.name" />
            </button>
            <span class="plate-copy">
              <strong>{{ plate.name }}</strong>
              <em>{{ plate.kind }}</em>
            </span>
          </li>
        </ul>
        <p v-else class="dim">定妆和场景图还在后台补，稍后刷新可见</p>
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
        <div class="turn-media">
          <div class="media-actions">
            <button class="btn" type="button" :disabled="imageBusy(turn)" @click="illustrate(turn)">
              {{ imageLabel(turn) }}
            </button>
            <button class="btn" type="button" :disabled="videoBusy(turn)" @click="film(turn)">
              {{ videoLabel(turn) }}
            </button>
          </div>
          <p v-if="turn.image_error" class="media-error">{{ turn.image_error }}</p>
          <p v-if="turn.video_error" class="media-error">{{ turn.video_error }}</p>
          <figure v-if="turn.image_url" class="still">
            <button
              type="button"
              class="still-open"
              :aria-expanded="viewer?.key === 'turn-' + turn.id"
              aria-haspopup="dialog"
              @click="openStill($event, turn.image_url, '这一幕的剧情图', 'turn-' + turn.id)"
            >
              <img :src="turn.image_url" alt="这一幕的剧情图" />
            </button>
          </figure>
          <video v-if="turn.video_url" class="clip" controls :src="turn.video_url"></video>
        </div>
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
const mediaBusy = ref<Record<string, true>>({})
const logEl = ref<HTMLElement | null>(null)
const viewer = ref<{ src: string; alt: string; key: string } | null>(null)
const viewerOpener = ref<HTMLButtonElement | null>(null)
const stillCloseButton = ref<HTMLButtonElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let platePollsLeft = 0

const PLATE_POLL_LIMIT = 60

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
const playAssets = computed(() => session.value?.assets || { characters: [], scenes: [], props: [] })
const LISTED_NAME_LIMIT = 40
const currentScenePlate = computed(() => {
  const scenes = playAssets.value.scenes || []
  const sceneId = latest.value?.scene_id
  if (sceneId) {
    const byId = scenes.find((scene: { id: number; image_url?: string | null }) => scene.id === sceneId)
    if (byId) return byId.image_url ? byId : null
  }
  if (!latest.value) return null
  const location = state.value.scene.location
  if (!location) return null
  return scenes.find((scene: { location?: string; image_url?: string | null }) => sameListedName(scene.location, location) && scene.image_url) || null
})
const people = computed(() => (state.value.characters || []).map((person: { name: string; role: string; status: string }) => {
  const plate = plateByName(playAssets.value.characters, person.name)
  return { ...person, plate_id: plate?.id ?? null, image_url: plate?.image_url || '' }
}))
const belongings = computed(() => (state.value.items || []).map((item: { name: string; holder: string; description: string }) => {
  const plate = plateByName(playAssets.value.props, item.name)
  return { ...item, plate_id: plate?.id ?? null, image_url: plate?.image_url || '' }
}))
const readyPlates = computed(() => {
  const rows: Array<{ key: string; kind: string; name: string; image_url: string }> = []
  for (const scene of playAssets.value.scenes || []) {
    if (!scene.image_url) continue
    rows.push({ key: `scene-${scene.id}`, kind: '场景', name: scene.location || '场景', image_url: scene.image_url })
  }
  for (const person of playAssets.value.characters || []) {
    if (!person.image_url) continue
    rows.push({ key: `character-${person.id}`, kind: '人物', name: person.name || '人物', image_url: person.image_url })
  }
  for (const item of playAssets.value.props || []) {
    if (!item.image_url) continue
    rows.push({ key: `prop-${item.id}`, kind: '物品', name: item.name || '物品', image_url: item.image_url })
  }
  return rows
})

function sameListedName(plateName: string | undefined, listedName: string) {
  if (!plateName || !listedName) return false
  if (plateName === listedName) return true
  return plateName.slice(0, LISTED_NAME_LIMIT) === listedName
}

function plateByName(rows: Array<{ id: number; name?: string; image_url?: string | null }> | undefined, name: string) {
  if (!name) return null
  return (rows || []).find(row => sameListedName(row.name, name) && row.image_url) || null
}

function busyKey(turnId: number, kind: 'image' | 'video') {
  return `${turnId}:${kind}`
}

function isTurnBusy(turnId: number, kind: 'image' | 'video') {
  return !!mediaBusy.value[busyKey(turnId, kind)]
}

function markBusy(turnId: number, kind: 'image' | 'video', active: boolean) {
  const key = busyKey(turnId, kind)
  const next = { ...mediaBusy.value }
  if (active) next[key] = true
  else delete next[key]
  mediaBusy.value = next
}

function imageBusy(turn: { id: number; image_status?: string | null }) {
  return isTurnBusy(turn.id, 'image') || turn.image_status === 'processing'
}

function videoBusy(turn: { id: number; video_status?: string | null }) {
  return isTurnBusy(turn.id, 'video') || turn.video_status === 'processing'
}

function imageLabel(turn: { id: number; image_url?: string | null; image_status?: string | null }) {
  if (imageBusy(turn)) return '剧情图绘制中'
  return turn.image_url ? '重画这一幕' : '生成剧情图'
}

function videoLabel(turn: { id: number; video_url?: string | null; video_status?: string | null }) {
  if (videoBusy(turn)) return '影像拍摄中'
  return turn.video_url ? '重拍这一幕' : '生成影像'
}

function questLabel(status: string) {
  if (status === 'done') return '完成'
  if (status === 'failed') return '失败'
  return '进行中'
}

async function load() {
  session.value = await rpgAPI.session(sessionId.value)
}

function needsMediaPoll() {
  return (session.value?.turns || []).some((turn: { image_status?: string | null; video_status?: string | null }) => (
    turn.image_status === 'processing' || turn.video_status === 'processing'
  ))
}

function platesPending() {
  const assets = playAssets.value
  const plates = [...(assets.scenes || []), ...(assets.characters || []), ...(assets.props || [])]
  return plates.length > 0 && plates.some((item: { image_url?: string | null }) => !item.image_url)
}

function armPlatePoll() {
  if (platesPending()) platePollsLeft = PLATE_POLL_LIMIT
}

function shouldPoll() {
  return needsMediaPoll() || (platePollsLeft > 0 && platesPending())
}

function startPoll() {
  stopPoll()
  if (!shouldPoll()) return
  pollTimer = setInterval(async () => {
    try {
      await load()
      if (platePollsLeft > 0) platePollsLeft -= 1
      if (!shouldPoll()) stopPoll()
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
    armPlatePoll()
    if (shouldPoll()) startPoll()
    await scrollLog()
  } catch (error) {
    toastError(error, { fallback: '这一幕没有写完' })
    await load().catch(() => {})
    armPlatePoll()
    if (shouldPoll()) startPoll()
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

watch(sessionId, () => {
  viewer.value = null
  viewerOpener.value = null
})

async function illustrate(turn: { id: number; image_url?: string | null; image_status?: string | null }) {
  if (imageBusy(turn)) return
  markBusy(turn.id, 'image', true)
  try {
    await rpgAPI.illustrate(sessionId.value, {
      turn_id: turn.id,
      ...(turn.image_url ? { force: true } : {}),
    })
    toast('正在对照定妆和场景图画这一幕')
    await load()
    armPlatePoll()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '剧情图没有画出来' })
  } finally {
    markBusy(turn.id, 'image', false)
  }
}

async function film(turn: { id: number; video_status?: string | null }) {
  if (videoBusy(turn)) return
  markBusy(turn.id, 'video', true)
  try {
    await rpgAPI.film(sessionId.value, { turn_id: turn.id })
    toast('正在拍这一幕，通常要几分钟')
    await load()
    armPlatePoll()
    startPoll()
  } catch (error) {
    toastError(error, { fallback: '影像没有拍出来' })
  } finally {
    markBusy(turn.id, 'video', false)
  }
}

onMounted(async () => {
  try {
    await load()
    armPlatePoll()
    if (!session.value?.turns?.length) {
      await shareOpening(sessionId.value, () => act({ mode: 'opening' }))
      if (!session.value?.turns?.length) {
        await load()
        armPlatePoll()
      }
    }
    if (shouldPoll()) startPoll()
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
.block li.with-plate { flex-direction: row; align-items: flex-start; gap: 10px; }
.who-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.block strong { font-size: 14px; }
.block span, .block em { font-style: normal; color: var(--text-2); font-size: 12px; }
.quest[data-status="done"] { color: var(--success); }
.quest[data-status="failed"] { color: var(--error); }
.media-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.media-error { color: var(--error); font-size: 12px; line-height: 1.5; }
.turn-media { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.plate-list { list-style: none; }
.block li.plate-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}
.plate-copy { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.plate-copy em { color: var(--text-3); font-size: 11px; letter-spacing: 0.08em; }
.plate-open {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: #111;
  border-radius: 10px;
  overflow: hidden;
  color: inherit;
  font: inherit;
  line-height: 0;
  cursor: zoom-in;
  appearance: none;
}
.plate-open img { display: block; width: 100%; height: 48px; object-fit: cover; }
.plate-open:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.plate-wide { margin-top: 8px; border-radius: 14px; }
.plate-wide img { height: 148px; }
.plate-portrait { width: 44px; flex: none; border-radius: 8px; }
.plate-portrait img { width: 44px; height: 58px; }
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
.turn .still, .turn .clip { max-width: 520px; }
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
