<template>
  <div class="page lobby">
    <header class="lobby-head">
      <p class="eyebrow">互动文字 RPG</p>
      <h1>织界</h1>
      <p class="lede">
        选一个世界，或自己写下设定。故事一幕一幕往下长。每一幕都会给出剧情走向，你也可以不选，直接写下你要做的事。看中的场面可以画成插画，再拍成一段影像。
      </p>
    </header>

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
          进入{{ world.title }}
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
          <button class="btn btn-primary" type="submit" :disabled="starting">开始这个世界</button>
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
import { toastError } from '~/composables/useToast'

const worlds = ref<any[]>([])
const sessions = ref<any[]>([])
const loading = ref(true)
const starting = ref(false)
const custom = reactive({ title: '', genre: '', premise: '' })

async function load() {
  const [worldRows, sessionRows] = await Promise.all([rpgAPI.worlds(), rpgAPI.sessions()])
  worlds.value = worldRows || []
  sessions.value = sessionRows || []
}

async function enterWorld(world: { id: number }) {
  if (starting.value) return
  starting.value = true
  try {
    const session = await rpgAPI.createSession({ world_id: world.id })
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
      style: '3d',
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
  .lobby-head h1 { font-size: 38px; }
}
</style>
