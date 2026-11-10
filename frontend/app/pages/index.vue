<template>
  <div class="page lobby">
    <header class="lobby-head">
      <p class="eyebrow">互动文字 RPG</p>
      <h1>幻书</h1>
      <p class="lede">
        选一个世界，或自己写下设定。故事一幕一幕往下长。每一幕都会给出剧情走向，你也可以不选，直接写下你要做的事。看中的场面可以画成插画，再拍成一段影像。
      </p>
    </header>

    <section class="hero-picker" aria-label="选择玩家主角">
      <div class="hero-picker-head">
        <div>
          <h2>选择主角</h2>
          <p class="dim">可选全局角色，也可以根据世界设定自动生成本局主角。</p>
        </div>
        <NuxtLink to="/characters" class="library-link">管理角色库</NuxtLink>
      </div>
      <div v-if="globalCharacters.length" class="hero-options">
        <button
          v-for="character in globalCharacters"
          :key="character.id"
          type="button"
          :class="['hero-option', { selected: selectedCharacterId === character.id }]"
          :aria-pressed="selectedCharacterId === character.id"
          @click="selectedCharacterId = selectedCharacterId === character.id ? null : character.id"
        >
          <img v-if="character.image_url" :src="publicMediaUrl(character.image_url)" :alt="''" />
          <span v-else class="hero-avatar">{{ character.name.slice(0, 1) }}</span>
          <span class="hero-option-copy"><strong>{{ character.name }}</strong><small>{{ character.role || '全局角色' }}</small></span>
          <span class="hero-check" aria-hidden="true">{{ selectedCharacterId === character.id ? '✓' : '' }}</span>
        </button>
      </div>
      <p v-else class="dim empty-hero">未选择全局角色时，会根据世界设定自动生成一位本局主角。</p>
    </section>

    <section v-if="loading" class="world-grid">
      <div v-for="n in 3" :key="n" class="world-card skeleton-card"></div>
    </section>

    <section v-else class="world-grid">
      <article v-for="world in worlds" :key="world.id" class="world-card">
        <div class="world-kicker">
          <span class="tag tag-accent">{{ world.genre }}</span>
        </div>
        <h2>{{ world.title }}</h2>
        <p class="tagline">{{ world.tagline }}</p>
        <p class="premise">{{ world.premise }}</p>
        <button class="btn btn-primary" type="button" :disabled="starting" @click="enterWorld(world)">
          {{ starting ? '正在准备世界…' : `进入${world.title}` }}
        </button>
      </article>
    </section>

    <section class="panel custom">
      <div>
        <h2>自己开一个世界</h2>
        <p class="dim">名字和一段设定就够。说书人会按你写的规矩开场。</p>
      </div>
      <form class="custom-form" @submit.prevent="enterCustom">
        <label class="field">
          <span class="field-label">世界名称</span>
          <input v-model.trim="custom.title" class="input" maxlength="40" placeholder="例如：潮声邮局" required />
        </label>
        <label class="field">
          <span class="field-label">类型</span>
          <input v-model.trim="custom.genre" class="input" maxlength="20" placeholder="奇谈、校园、盗墓…" />
        </label>
        <label class="field field-wide">
          <span class="field-label">设定</span>
          <textarea v-model.trim="custom.premise" class="input" rows="4" maxlength="2000" placeholder="你是谁，眼前有什么麻烦，世界不许打破的规矩。" required></textarea>
        </label>
        <div class="custom-actions">
          <button class="btn btn-primary" type="submit" :disabled="starting">
            {{ starting ? '正在准备世界…' : '开始这个世界' }}
          </button>
        </div>
      </form>
    </section>

    <section v-if="sessions.length" class="continues">
      <h2>接着玩</h2>
      <div class="continue-row">
        <button
          v-for="item in sessions"
          :key="item.id"
          class="continue-card"
          type="button"
          @click="navigateTo(`/play/${item.id}`)"
        >
          <strong>{{ item.title }}</strong>
          <span class="dim">第 {{ item.turn_count || 0 }} 幕</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { rpgAPI } from '~/composables/useApi'
import { publicMediaUrl } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'

const worlds = ref<any[]>([])
const sessions = ref<any[]>([])
const globalCharacters = ref<any[]>([])
const selectedCharacterId = ref<number | null>(null)
const loading = ref(true)
const starting = ref(false)
const custom = reactive({ title: '', genre: '', premise: '' })

async function load() {
  const [worldRows, sessionRows, characterRows] = await Promise.all([rpgAPI.worlds(), rpgAPI.sessions(), rpgAPI.globalCharacters()])
  worlds.value = worldRows || []
  sessions.value = sessionRows || []
  globalCharacters.value = characterRows || []
}

async function enterWorld(world: { id: number }) {
  if (starting.value) return
  starting.value = true
  try {
    const session = await rpgAPI.createSession({ world_id: world.id, global_character_id: selectedCharacterId.value || undefined })
    await navigateTo(`/play/${session.id}`)
  } catch (error) {
    toastError(error, { fallback: '这个世界暂时进不去' })
  } finally {
    starting.value = false
  }
}

async function enterCustom() {
  if (starting.value) return
  starting.value = true
  try {
    const session = await rpgAPI.createSession({
      title: custom.title,
      genre: custom.genre || '原创',
      premise: custom.premise,
      global_character_id: selectedCharacterId.value || undefined,
    })
    await navigateTo(`/play/${session.id}`)
  } catch (error) {
    toastError(error, { fallback: '这个世界暂时进不去' })
  } finally {
    starting.value = false
  }
}

onMounted(async () => {
  try {
    await load()
  } catch (error) {
    toastError(error, { fallback: '世界列表没有载入' })
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.lobby {
  height: 100%;
  overflow: auto;
  padding: 28px 32px 48px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--accent-text);
  font-weight: 700;
}
.lobby-head h1 {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
  font-size: 48px;
  line-height: 1;
  margin: 8px 0 12px;
  letter-spacing: -0.03em;
}
.lede { max-width: 680px; color: var(--text-2); font-size: 15px; line-height: 1.7; }
.hero-picker { display: grid; gap: 12px; padding: 15px 0 17px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.hero-picker-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.hero-picker-head h2 { font-size: 16px; margin-bottom: 3px; }
.hero-picker-head .dim, .empty-hero { color: var(--text-2); font-size: 12px; line-height: 1.5; }
.library-link { color: var(--accent-text); font-size: 12px; text-decoration: none; white-space: nowrap; }
.library-link:hover { text-decoration: underline; }
.hero-options { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 3px; }
.hero-option { width: 206px; min-width: 206px; height: 58px; display: flex; align-items: center; gap: 10px; padding: 7px; text-align: left; color: var(--text-0); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.hero-option.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-bg); }
.hero-option img, .hero-avatar { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 4px; object-fit: cover; background: var(--bg-2); }
.hero-avatar { display: grid; place-items: center; color: var(--accent-text); font-size: 18px; font-weight: 700; }
.hero-option-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.hero-option-copy strong, .hero-option-copy small { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.hero-option-copy strong { font-size: 13px; }
.hero-option-copy small { color: var(--text-3); font-size: 11px; }
.hero-check { width: 18px; height: 18px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 50%; color: var(--accent-text); font-size: 11px; }
.hero-option.selected .hero-check { border-color: var(--accent); background: var(--accent); color: white; }
.empty-hero { padding: 0; }
.world-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}
.world-card, .panel, .continue-card {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow-xs);
}
.world-card { padding: 18px 18px 16px; display: flex; flex-direction: column; gap: 8px; min-height: 280px; }
.world-card h2, .panel h2, .continues h2 {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
  font-size: 26px;
  letter-spacing: -0.02em;
}
.tagline { color: var(--text-1); font-size: 14px; }
.premise {
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.65;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}
.world-card .btn { margin-top: 8px; align-self: flex-start; }
.skeleton-card { min-height: 280px; background: linear-gradient(90deg, var(--bg-2), var(--bg-3), var(--bg-2)); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
.panel { padding: 20px; display: grid; gap: 16px; }
.custom-form { display: grid; grid-template-columns: 1fr 180px; gap: 12px; }
.field-wide, .custom-actions { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 650; color: var(--text-2); }
textarea.input { resize: vertical; min-height: 96px; line-height: 1.6; padding: 10px 12px; }
.continues h2 { font-size: 22px; margin-bottom: 10px; }
.continue-row { display: flex; gap: 10px; flex-wrap: wrap; }
.continue-card {
  padding: 12px 14px;
  min-width: 180px;
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: inherit;
}
.continue-card:hover { border-color: var(--accent); }
@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
@media (max-width: 980px) {
  .world-grid, .custom-form { grid-template-columns: 1fr; }
  .hero-picker-head { align-items: flex-start; flex-direction: column; gap: 6px; }
  .lobby-head h1 { font-size: 38px; }
}
</style>
