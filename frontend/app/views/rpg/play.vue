<template>
  <div class="play">
    <aside class="dossier">
      <button class="back" type="button" @click="navigateTo('/')">← 世界</button>
      <p class="eyebrow">{{ session?.world?.genre || '幻书' }}</p>
      <h1>{{ session?.title || '幻书' }}</h1>
      <p v-if="session?.world?.tagline" class="tagline">{{ session.world.tagline }}</p>

      <section v-if="session?.player_character" class="block player-character-block">
        <div class="block-heading">
          <h2>本局主角</h2>
          <button class="text-action" type="button" :disabled="acting" @click="openCharacterEditor">编辑</button>
        </div>
        <div class="player-character-summary">
          <img v-if="session.player_character.image_url" :src="session.player_character.image_url" :alt="''" />
          <div>
            <strong>{{ session.player_character.name }}</strong>
            <span>{{ session.player_character.role }}</span>
          </div>
        </div>
        <p v-if="session.player_character.appearance" class="character-note"><b><span>固定外貌<span class="change-tag">跨世界不变</span></span></b>{{ session.player_character.appearance }}</p>
        <p v-if="session.player_character.physique" class="character-note"><b><span>固定身材<span class="change-tag">跨世界不变</span></span></b>{{ session.player_character.physique }}</p>
        <template v-for="field in playerCharacterSummaryFields" :key="field.key">
          <p v-if="session.player_character[field.key]" class="character-note"><b>{{ field.label }}</b>{{ session.player_character[field.key] }}</p>
        </template>
      </section>
      <section v-else class="block player-character-block">
        <h2>本局主角</h2>
        <p class="dim">还没有主角。可以按世界设定生成一位，也可以从全局角色库中选择。</p>
        <div class="missing-player-actions">
          <button class="btn btn-primary" type="button" :disabled="acting || generatingPlayerCharacter" @click="generateWorldPlayerCharacter">
            <Loader2 v-if="generatingPlayerCharacter" :size="13" class="spin" />
            {{ generatingPlayerCharacter ? '生成中' : '生成默认主角' }}
          </button>
          <button class="text-action" type="button" :disabled="acting || generatingPlayerCharacter" @click="openCharacterPicker">选择已有角色</button>
        </div>
        <NuxtLink class="studio-link character-library-link" to="/characters">创建或编辑全局角色</NuxtLink>
      </section>

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
          <li v-for="person in people" :key="person.character_id || person.name" class="character-row">
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
            <span v-else class="character-avatar"><UserRound :size="16" /></span>
            <div class="who-copy">
              <strong>{{ person.name }}</strong>
              <span>{{ person.role }}</span>
              <em>{{ person.status }}</em>
            </div>
            <button
              v-if="person.character_id"
              type="button"
              class="text-action character-edit-action"
              :disabled="savingStoryCharacter"
              @click="openStoryCharacterEditor(person.character_id)"
            >编辑</button>
          </li>
        </ul>
        <p v-else class="dim">{{ session?.asset_sync_pending ? '正在提取本集人物…' : '本集还没有提取到人物。' }}</p>
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
      <div ref="logEl" class="log" @scroll.passive="onLogScroll">
      <div ref="logBody" class="log-body">
      <p v-if="showOpeningWait" class="waiting">正在推开这一局…</p>
      <article v-else-if="showStalledOpening" class="turn stalled">
        <p class="waiting">{{ stageError || '这一幕没有写出来。' }}</p>
        <button class="btn" type="button" @click="retryOpening">再写一次</button>
      </article>
      <article v-for="turn in session?.turns || []" :key="turn.id" class="turn">
        <p v-if="turn.player_mode === 'choice'" class="player-line">你选择了：{{ turn.player_text }}</p>
        <p v-else-if="turn.player_mode === 'free'" class="player-line">你写下：{{ turn.player_text }}</p>
        <p class="narrative">{{ turn.narrative }}</p>
        <div class="turn-media">
          <div class="media-actions">
            <button class="btn" type="button" :disabled="imageBusy(turn) || session?.asset_sync_pending" @click="illustrate(turn)">
              {{ imageLabel(turn) }}
            </button>
            <button class="btn" type="button" :disabled="videoBusy(turn) || session?.asset_sync_pending" @click="film(turn)">
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
      <article v-if="acting" class="turn live" aria-busy="true">
        <p v-if="pendingAction" class="player-line">{{ pendingAction }}</p>
        <p class="waiting" role="status">正在书写这一幕…<span class="caret" aria-hidden="true"></span></p>
      </article>
      </div>
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

    <Teleport to="body">
      <div v-if="characterEditorOpen" class="overlay character-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="character-editor-title" @click.self="characterEditorOpen = false">
        <section class="dialog character-editor-dialog">
          <header class="dialog-head">
            <div>
              <span class="eyebrow">{{ session?.player_character?.name }}</span>
              <h2 id="character-editor-title">编辑本局主角</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭" @click="characterEditorOpen = false">×</button>
          </header>
          <div class="dialog-body character-editor-fields">
            <label class="field"><span>本世界姓名</span><input v-model="playerCharacterDraft.name" class="input" maxlength="80" /></label>
            <label class="field"><span>本世界身份</span><input v-model="playerCharacterDraft.role" class="input" maxlength="120" /></label>
            <label class="field"><span>固定外貌<span class="change-tag">跨世界不变</span></span><textarea v-model="playerCharacterDraft.appearance" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>固定身材<span class="change-tag">跨世界不变</span></span><textarea v-model="playerCharacterDraft.physique" class="textarea" rows="2" maxlength="4000" /></label>
            <label class="field"><span>本世界性格</span><textarea v-model="playerCharacterDraft.personality" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界价值观</span><textarea v-model="playerCharacterDraft.values" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界说话方式</span><textarea v-model="playerCharacterDraft.speech" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界习惯</span><textarea v-model="playerCharacterDraft.habits" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界愿望</span><textarea v-model="playerCharacterDraft.desires" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界恐惧</span><textarea v-model="playerCharacterDraft.fears" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界在乎的人</span><textarea v-model="playerCharacterDraft.relationships" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界能力</span><textarea v-model="playerCharacterDraft.abilities" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界经历</span><textarea v-model="playerCharacterDraft.background" class="textarea" rows="4" maxlength="4000" /></label>
            <label class="field"><span>本世界服装与妆造</span><textarea v-model="playerCharacterDraft.styling" class="textarea" rows="3" maxlength="4000" /></label>
          </div>
          <footer class="dialog-foot">
            <span class="dim">修改会用于后续章节。修改外貌、身材或服装会重新生成角色定妆图。</span>
            <button class="btn btn-primary" type="button" :disabled="savingPlayerCharacter" @click="savePlayerCharacter">
              <Loader2 v-if="savingPlayerCharacter" :size="13" class="spin" />
              {{ savingPlayerCharacter ? '保存中' : '保存本局设定' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="storyCharacterEditorOpen && editingStoryCharacter" class="overlay character-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="story-character-editor-title" @click.self="!savingStoryCharacter && (storyCharacterEditorOpen = false)">
        <section class="dialog character-editor-dialog">
          <header class="dialog-head">
            <div>
              <span class="eyebrow">剧情人物</span>
              <h2 id="story-character-editor-title">{{ editingStoryCharacter.name }}</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭" :disabled="savingStoryCharacter" @click="storyCharacterEditorOpen = false"><X :size="15" /></button>
          </header>
          <div class="dialog-body character-editor-fields">
            <label class="field"><span>身份</span><input v-model="storyCharacterDraft.role" class="input" maxlength="120" /></label>
            <label class="field"><span>固定外貌</span><textarea v-model="storyCharacterDraft.appearance" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>身材与体态</span><textarea v-model="storyCharacterDraft.physique" class="textarea" rows="2" maxlength="4000" /></label>
            <label class="field"><span>本世界性格</span><textarea v-model="storyCharacterDraft.personality" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界背景经历</span><textarea v-model="storyCharacterDraft.background" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>本世界服装与妆造</span><textarea v-model="storyCharacterDraft.styling" class="textarea" rows="3" maxlength="4000" /></label>
            <label class="field"><span>补充描述</span><textarea v-model="storyCharacterDraft.description" class="textarea" rows="2" maxlength="4000" /></label>
          </div>
          <footer class="dialog-foot">
            <div class="story-character-global-action">
              <button v-if="!editingStoryCharacter.global_character_id" class="btn" type="button" :disabled="savingStoryCharacter" @click="saveStoryCharacterToGlobal">
                <Loader2 v-if="savingStoryCharacter" :size="13" class="spin" />
                保存为全局角色
              </button>
              <span v-else class="story-character-saved">已保存到全局角色</span>
            </div>
            <button class="btn btn-primary" type="button" :disabled="savingStoryCharacter" @click="saveStoryCharacter">
              <Loader2 v-if="savingStoryCharacter" :size="13" class="spin" />
              {{ savingStoryCharacter ? '保存中' : '保存修改' }}
            </button>
          </footer>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="characterPickerOpen" class="overlay character-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="character-picker-title" @click.self="characterPickerOpen = false">
        <section class="dialog character-editor-dialog">
          <header class="dialog-head">
            <div>
              <span class="eyebrow">本局主角</span>
              <h2 id="character-picker-title">选择全局角色</h2>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭" @click="characterPickerOpen = false">×</button>
          </header>
          <div v-if="globalCharacters.length" class="global-character-options">
            <button
              v-for="character in globalCharacters"
              :key="character.id"
              class="global-character-option"
              type="button"
              :disabled="selectingCharacter"
              @click="selectGlobalCharacter(character)"
            >
              <img v-if="character.image_url" :src="publicMediaUrl(character.image_url)" :alt="''" />
              <span v-else class="global-character-avatar"><UserRound :size="17" /></span>
              <span><strong>{{ character.name }}</strong><small>{{ character.role || '全局角色' }}</small></span>
              <Loader2 v-if="selectingCharacterId === character.id" :size="14" class="spin" />
            </button>
          </div>
          <div v-else class="empty-character-picker">
            <p class="dim">角色库还是空的。</p>
            <NuxtLink class="btn btn-primary" to="/characters" @click="characterPickerOpen = false">创建或生成角色</NuxtLink>
          </div>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Loader2, UserRound, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { characterAPI, rpgAPI } from '~/composables/useApi'
import { publicMediaUrl } from '~/composables/useMedia'
import { mapError, toastError } from '~/composables/useToast'
import { shareOpening } from '~/utils/rpg-opening'

const route = useRoute()
const sessionId = computed(() => Number(route.params.sessionId))
const session = ref<any>(null)
const loading = ref(true)
const acting = ref(false)
const awaitingOpening = ref(false)
const stageError = ref('')
const freeText = ref('')
const pendingAction = ref('')
const mediaBusy = ref<Record<string, true>>({})
const logEl = ref<HTMLElement | null>(null)
const logBody = ref<HTMLElement | null>(null)
let stickToBottom = true
let logResizeObserver: ResizeObserver | null = null
let playDisposed = false
const viewer = ref<{ src: string; alt: string; key: string } | null>(null)
const characterEditorOpen = ref(false)
const characterPickerOpen = ref(false)
const storyCharacterEditorOpen = ref(false)
const savingPlayerCharacter = ref(false)
const generatingPlayerCharacter = ref(false)
const savingStoryCharacter = ref(false)
const selectingCharacter = ref(false)
const selectingCharacterId = ref<number | null>(null)
const playerCharacterSummaryFields = [
  { key: 'personality', label: '本世界性格' },
  { key: 'values', label: '本世界价值观' },
  { key: 'speech', label: '本世界说话方式' },
  { key: 'habits', label: '本世界习惯' },
  { key: 'desires', label: '本世界愿望' },
  { key: 'fears', label: '本世界恐惧' },
  { key: 'relationships', label: '本世界在乎的人' },
  { key: 'abilities', label: '本世界能力' },
  { key: 'background', label: '本世界经历' },
  { key: 'styling', label: '本世界服装与妆造' },
] as const
const playerCharacterDraft = ref({
  name: '', role: '', appearance: '', physique: '', personality: '', values: '', speech: '', habits: '',
  desires: '', fears: '', relationships: '', abilities: '', background: '', styling: '',
})
const editingStoryCharacter = ref<any>(null)
const storyCharacterDraft = ref({ role: '', description: '', appearance: '', physique: '', personality: '', background: '', styling: '' })
const globalCharacters = ref<any[]>([])
const viewerOpener = ref<HTMLButtonElement | null>(null)
const stillCloseButton = ref<HTMLButtonElement | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
let platePollsLeft = 0

const PLATE_POLL_LIMIT = 60

useHead(() => ({ title: session.value?.title ? `${session.value.title} · 幻书` : '幻书' }))

const hasTurns = computed(() => (session.value?.turns || []).length > 0)
const showOpeningWait = computed(() => !acting.value && !hasTurns.value && !stageError.value && (loading.value || awaitingOpening.value))
const showStalledOpening = computed(() => !acting.value && !hasTurns.value && !loading.value && (!!stageError.value || !awaitingOpening.value))
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
const people = computed(() => {
  const plates = playAssets.value.characters || []
  const listed = (state.value.characters || []).map((person: { name: string; role: string; status: string }) => {
    const plate = plateByName(plates, person.name)
    return {
      ...person,
      role: plate?.role || person.role,
      character_id: plate?.id ?? null,
      plate_id: plate?.id ?? null,
      image_url: plate?.image_url || '',
    }
  })
  const extracted = plates
    .filter((plate: { name?: string }) => plate.name && !listed.some((person: { name: string }) => sameListedName(plate.name!, person.name)))
    .map((plate: { id: number; name: string; role?: string; image_url?: string | null }) => ({
      name: plate.name,
      role: plate.role || '剧情人物',
      status: '本集角色',
      character_id: plate.id,
      plate_id: plate.id,
      image_url: plate.image_url || '',
    }))
  return [...listed, ...extracted]
})
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

function plateByName(rows: Array<{ id: number; name?: string; role?: string; image_url?: string | null }> | undefined, name: string) {
  if (!name) return null
  return (rows || []).find(row => sameListedName(row.name, name)) || null
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

function openCharacterEditor() {
  const character = session.value?.player_character
  if (!character) return
  playerCharacterDraft.value = {
    name: character.name || '',
    role: character.role || '',
    appearance: character.appearance || '',
    physique: character.physique || '',
    personality: character.personality || '',
    values: character.values || '',
    speech: character.speech || '',
    habits: character.habits || '',
    desires: character.desires || '',
    fears: character.fears || '',
    relationships: character.relationships || '',
    abilities: character.abilities || '',
    background: character.background || '',
    styling: character.styling || '',
  }
  characterEditorOpen.value = true
}

async function openCharacterPicker() {
  try {
    globalCharacters.value = await rpgAPI.globalCharacters() || []
    characterPickerOpen.value = true
  } catch (error) {
    toastError(error, { fallback: '角色库载入失败' })
  }
}

async function selectGlobalCharacter(character: { id: number }) {
  if (selectingCharacter.value) return
  selectingCharacter.value = true
  selectingCharacterId.value = character.id
  try {
    session.value = await rpgAPI.updatePlayerCharacter(sessionId.value, { global_character_id: character.id })
    characterPickerOpen.value = false
    armPlatePoll()
    if (shouldPoll()) startPoll()
    toast.success('本局主角已加入，下一幕会按当前世界适配')
  } catch (error) {
    toastError(error, { fallback: '主角没有加入本局' })
  } finally {
    selectingCharacter.value = false
    selectingCharacterId.value = null
  }
}

async function generateWorldPlayerCharacter() {
  if (generatingPlayerCharacter.value) return
  generatingPlayerCharacter.value = true
  try {
    session.value = await rpgAPI.updatePlayerCharacter(sessionId.value, { generate_default: true })
    armPlatePoll()
    if (shouldPoll()) startPoll()
    toast.success('本局主角已生成')
  } catch (error) {
    toastError(error, { fallback: '主角生成失败' })
  } finally {
    generatingPlayerCharacter.value = false
  }
}

async function savePlayerCharacter() {
  if (savingPlayerCharacter.value) return
  savingPlayerCharacter.value = true
  try {
    session.value = await rpgAPI.updatePlayerCharacter(sessionId.value, playerCharacterDraft.value)
    characterEditorOpen.value = false
    armPlatePoll()
    if (shouldPoll()) startPoll()
    toast.success('本局主角设定已保存')
  } catch (error) {
    toastError(error, { fallback: '角色资料保存失败' })
  } finally {
    savingPlayerCharacter.value = false
  }
}

function openStoryCharacterEditor(characterId: number) {
  const character = (playAssets.value.characters || []).find((item: { id: number }) => item.id === characterId)
  if (!character) return
  editingStoryCharacter.value = character
  storyCharacterDraft.value = {
    role: character.role || '',
    description: character.description || '',
    appearance: character.appearance || '',
    physique: character.physique || '',
    personality: character.personality || '',
    background: character.background || '',
    styling: character.styling || '',
  }
  storyCharacterEditorOpen.value = true
}

async function updateStoryCharacter() {
  const character = editingStoryCharacter.value
  if (!character?.id) return false
  await characterAPI.update(character.id, storyCharacterDraft.value)
  await load()
  armPlatePoll()
  if (shouldPoll()) startPoll()
  return true
}

async function saveStoryCharacter() {
  if (savingStoryCharacter.value) return
  savingStoryCharacter.value = true
  try {
    await updateStoryCharacter()
    storyCharacterEditorOpen.value = false
    toast.success('剧情人物已保存')
  } catch (error) {
    toastError(error, { fallback: '角色资料保存失败' })
  } finally {
    savingStoryCharacter.value = false
  }
}

async function saveStoryCharacterToGlobal() {
  const character = editingStoryCharacter.value
  if (!character?.id || savingStoryCharacter.value) return
  const previousImage = character.image_url
  const changed = Object.entries(storyCharacterDraft.value).some(([key, value]) => value !== (character[key] || ''))
  savingStoryCharacter.value = true
  try {
    await updateStoryCharacter()
    const saved = await characterAPI.saveGlobal(character.id)
    character.global_character_id = saved.id
    const current = (playAssets.value.characters || []).find((item: { id: number }) => item.id === character.id)
    if (current) current.global_character_id = saved.id
    toast.success(changed && previousImage && saved.image_url === previousImage
      ? '已保存到全局角色，头像沿用修改前的图片'
      : '已保存到全局角色')
  } catch (error) {
    toastError(error, { fallback: '保存全局角色失败' })
  } finally {
    savingStoryCharacter.value = false
  }
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
  return needsMediaPoll() || !!session.value?.asset_sync_pending || (platePollsLeft > 0 && platesPending())
}

function startPoll() {
  stopPoll()
  if (!shouldPoll()) return
  pollTimer = setInterval(async () => {
    try {
      await load()
      if (!session.value?.asset_sync_pending && platesPending() && platePollsLeft === 0) armPlatePoll()
      if (platePollsLeft > 0) platePollsLeft -= 1
      if (!shouldPoll()) stopPoll()
    } catch { /* 下一轮再问 */ }
  }, 3000)
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

const BOTTOM_STICK_GAP = 48

function distanceFromBottom(log: HTMLElement) {
  return log.scrollHeight - log.clientHeight - log.scrollTop
}

function pinLog() {
  const log = logEl.value
  if (!log) return
  log.scrollTop = log.scrollHeight
}

async function scrollLog() {
  await nextTick()
  pinLog()
  requestAnimationFrame(pinLog)
}

function onLogScroll() {
  const log = logEl.value
  if (!log) return
  stickToBottom = distanceFromBottom(log) <= BOTTOM_STICK_GAP
}

function showPersistedSession(nextSession: any) {
  session.value = nextSession
  pendingAction.value = ''
  acting.value = false
}

function retryOpening() {
  stageError.value = ''
  return act({ mode: 'opening' })
}

async function act(body: { mode: string; choice_id?: string; text?: string }) {
  if (acting.value) return
  stageError.value = ''
  acting.value = true
  stickToBottom = true
  if (body.mode === 'choice') {
    const choice = choices.value.find((item: { id: string; label: string }) => item.id === body.choice_id)
    pendingAction.value = choice ? `你选择了：${choice.label}` : ''
  } else if (body.mode === 'free') {
    pendingAction.value = `你写下：${body.text}`
  } else {
    pendingAction.value = ''
  }
  scrollLog()
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
    // 流式片段和落库后的正文可能不一致，页面只展示已经写入的回合。
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''
      for (const block of blocks) {
        const event = parseSse(block)
        if (!event) continue
        if (event.event === 'error') failure = event.data.message || '这一幕没有写完'
      }
    }
    const tail = parseSse(buffer)
    if (tail?.event === 'error') failure = tail.data.message || failure
    if (failure) throw new Error(failure)
    const nextSession = await rpgAPI.session(sessionId.value)
    freeText.value = ''
    showPersistedSession(nextSession)
    armPlatePoll()
    if (shouldPoll()) startPoll()
    await scrollLog()
  } catch (error) {
    stageError.value = mapError(error, { fallback: '这一幕没有写完' })
    try {
      toastError(error, { fallback: '这一幕没有写完' })
      const nextSession = await rpgAPI.session(sessionId.value)
      showPersistedSession(nextSession)
    } catch {
      pendingAction.value = ''
      acting.value = false
    }
    armPlatePoll()
    if (shouldPoll()) startPoll()
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
      awaitingOpening.value = true
      try {
        await shareOpening(sessionId.value, () => act({ mode: 'opening' }))
      } finally {
        awaitingOpening.value = false
      }
      if (!session.value?.turns?.length) {
        await load()
        armPlatePoll()
      }
    }
    if (shouldPoll()) startPoll()
    stickToBottom = true
    await scrollLog()
  } catch (error) {
    toastError(error, { fallback: '这一局没有打开' })
  } finally {
    loading.value = false
    await scrollLog()
  }
  if (!playDisposed && logBody.value) {
    logResizeObserver = new ResizeObserver(() => {
      if (stickToBottom) pinLog()
    })
    logResizeObserver.observe(logBody.value)
  }
})

onBeforeUnmount(() => {
  playDisposed = true
  stopPoll()
  logResizeObserver?.disconnect()
  window.removeEventListener('keydown', onStillViewerKeydown)
})
</script>

<style scoped>
.play {
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
.stage {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.log {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 28px 8vw 32px;
}
.log-body { display: flex; flex-direction: column; gap: 22px; }
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
.block-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.text-action { padding: 2px 5px; border: 0; background: transparent; color: var(--accent-text); font-size: 12px; cursor: pointer; }
.text-action:disabled { opacity: .5; cursor: default; }
.player-character-summary { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.player-character-summary img { width: 42px; height: 42px; object-fit: cover; border-radius: 4px; background: var(--bg-2); }
.player-character-summary > div { display: flex; flex-direction: column; gap: 3px; }
.player-character-summary strong { font-size: 14px; }
.player-character-summary span { color: var(--text-2); font-size: 12px; }
.character-note { margin-top: 6px; color: var(--text-2); font-size: 12px; line-height: 1.55; }
.character-note b { margin-right: 6px; color: var(--text-3); font-weight: 600; }
.change-tag { margin-left: 6px; color: var(--text-3); font-size: 10px; font-weight: 400; white-space: nowrap; }
.character-editor-dialog { width: min(600px, calc(100vw - 32px)); max-height: min(86vh, 760px); overflow: auto; }
.character-editor-fields { display: grid; gap: 14px; }
.character-editor-fields .field { display: grid; gap: 6px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.character-editor-fields textarea, .character-editor-fields input { width: 100%; resize: vertical; color: var(--text-0); font: inherit; font-weight: 400; font-size: 13px; }
.character-editor-dialog .dialog-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 14px; }
.character-editor-dialog .dialog-foot .dim { font-size: 11px; }
.character-editor-dialog .dialog-foot > .dim { flex: 1 1 260px; }
.character-editor-dialog .dialog-foot .btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.story-character-global-action { min-width: 0; }
.story-character-saved { color: var(--success); font-size: 12px; }
.character-row { display: flex; flex-direction: row !important; align-items: center; gap: 9px; min-width: 0; }
.character-avatar { width: 44px; height: 58px; flex: 0 0 44px; display: grid; place-items: center; color: var(--text-3); background: var(--bg-2); border-radius: 8px; }
.character-row .who-copy { flex: 1; }
.character-edit-action { flex: none; }
.character-library-link { display: inline-block; margin-top: 6px; color: var(--accent-text); }
.global-character-options { display: grid; gap: 7px; padding-top: 14px; }
.global-character-option { min-width: 0; min-height: 58px; display: flex; align-items: center; gap: 10px; padding: 7px; color: var(--text-0); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 6px; text-align: left; cursor: pointer; }
.global-character-option:hover { border-color: var(--accent); }
.global-character-option:disabled { opacity: .65; cursor: wait; }
.global-character-option img, .global-character-avatar { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 4px; object-fit: cover; background: var(--bg-2); }
.global-character-avatar { display: grid; place-items: center; color: var(--text-3); }
.global-character-option > span:nth-child(2) { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.global-character-option strong, .global-character-option small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.global-character-option strong { font-size: 13px; }
.global-character-option small { color: var(--text-2); font-size: 11px; }
.empty-character-picker { display: grid; justify-items: start; gap: 12px; padding-top: 16px; }
.missing-player-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
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
.stalled { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
.turn { flex: none; max-width: 720px; }
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
  flex: none;
  position: static;
  z-index: 1;
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
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
  .log { padding: 18px 16px 28px; }
  .dock { padding: 10px 16px 14px; }
  .choices { grid-template-columns: 1fr; }
  .free textarea { min-height: 44px; }
  .free-row { grid-template-columns: 1fr; }
}
</style>
