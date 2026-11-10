<template>
  <main class="character-library">
    <header class="page-head">
      <div>
        <p class="eyebrow">幻书 · 角色资料</p>
        <h1>全局角色库</h1>
        <p class="lede">保存稳定身份与默认设定。进入不同世界时，本局性格、经历和服装会单独适配。</p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="saving || generating" @click="startNew">
        <Plus :size="15" /> 新建角色
      </button>
    </header>

    <div class="library-layout">
      <section class="roster" aria-label="全局角色列表">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="query" type="search" placeholder="搜索角色" />
        </label>
        <p class="roster-count">{{ filteredCharacters.length }} 位角色</p>
        <button
          v-for="character in filteredCharacters"
          :key="character.id"
          type="button"
          :class="['roster-item', { active: draft.id === character.id }]"
          @click="edit(character)"
        >
          <img v-if="character.image_url" :src="publicMediaUrl(character.image_url)" :alt="''" />
          <span v-else class="avatar"><UserRound :size="18" /></span>
          <span class="roster-copy">
            <strong>{{ character.name }}</strong>
            <small>{{ character.role || '角色' }}</small>
          </span>
          <ChevronRight :size="15" class="roster-chevron" />
        </button>
        <p v-if="!loading && !filteredCharacters.length" class="empty-roster">
          {{ characters.length ? '没有匹配的角色' : '角色库还是空的' }}
        </p>
      </section>

      <form class="editor" @submit.prevent="save">
        <div class="editor-head">
          <div>
            <span class="editor-kicker">{{ draft.id ? '全局身份' : '创建身份' }}</span>
            <h2>{{ draft.name || '新角色' }}</h2>
          </div>
          <span v-if="draft.id" class="saved-mark"><ShieldCheck :size="14" /> 跨世界复用</span>
        </div>

        <div class="generation-tools">
          <label class="field">
            <span>角色构想</span>
            <textarea v-model.trim="generationBrief" class="input" rows="2" maxlength="2000" placeholder="例如：一个在海边小城长大的年轻法医，擅长观察细节" />
          </label>
          <button class="btn" type="button" :disabled="generating || !generationBrief.trim()" @click="generate">
            <Loader2 v-if="generating" :size="14" class="spin" />
            <WandSparkles v-else :size="14" />
            {{ generating ? '生成中' : '生成草稿' }}
          </button>
        </div>

        <div class="editor-grid">
          <label class="field">
            <span>姓名</span>
            <input v-model.trim="draft.name" class="input" maxlength="80" required placeholder="角色姓名" />
          </label>
          <label class="field">
            <span>默认身份</span>
            <input v-model.trim="draft.role" class="input" maxlength="120" placeholder="例如：调查记者" />
          </label>
          <label class="field field-wide">
            <span>固定外貌</span>
            <textarea v-model.trim="draft.appearance" class="input" rows="3" maxlength="2000" placeholder="年龄感、五官、发色、辨识度等稳定特征" />
          </label>
          <label class="field field-wide">
            <span>固定身材与体态</span>
            <textarea v-model.trim="draft.physique" class="input" rows="2" maxlength="1200" placeholder="身高、体型、体态等不随世界变化的特征" />
          </label>
          <label class="field field-wide">
            <span>默认性格</span>
            <textarea v-model.trim="draft.default_personality" class="input" rows="3" maxlength="2000" placeholder="角色通常的性格、处事方式和价值观" />
          </label>
          <label class="field field-wide">
            <span>默认服装与妆造</span>
            <textarea v-model.trim="draft.default_styling" class="input" rows="3" maxlength="2000" placeholder="作为跨世界适配起点的发型、服装和配饰" />
          </label>
          <label class="field field-wide">
            <span>参考形象地址</span>
            <input v-model.trim="draft.image_url" class="input" type="text" placeholder="https://… 或 /static/…" />
          </label>
        </div>

        <div v-if="draft.image_url" class="reference-preview">
          <img :src="publicMediaUrl(draft.image_url)" :alt="`${draft.name || '角色'}参考形象`" />
          <span>身份参考图</span>
        </div>

        <footer class="editor-actions">
          <button v-if="draft.id" class="btn btn-danger" type="button" :disabled="saving || generating" @click="remove">
            <Trash2 :size="14" /> 删除角色
          </button>
          <span class="action-spacer"></span>
          <button class="btn" type="button" :disabled="saving || generating" @click="startNew">清空</button>
          <button class="btn btn-primary" type="submit" :disabled="saving || generating || !draft.name.trim()">
            <Loader2 v-if="saving" :size="14" class="spin" />
            <Save v-else :size="14" />
            {{ saving ? '保存中' : '保存角色' }}
          </button>
        </footer>
      </form>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ChevronRight, Loader2, Plus, Save, Search, ShieldCheck, Trash2, UserRound, WandSparkles } from 'lucide-vue-next'
import { globalCharacterAPI } from '~/composables/useApi'
import { publicMediaUrl } from '~/composables/useMedia'
import { toastError } from '~/composables/useToast'
import { toast } from 'vue-sonner'

type GlobalCharacter = {
  id: number
  name: string
  role?: string | null
  appearance?: string | null
  physique?: string | null
  default_personality?: string | null
  default_styling?: string | null
  image_url?: string | null
}

const characters = ref<GlobalCharacter[]>([])
const loading = ref(true)
const saving = ref(false)
const generating = ref(false)
const query = ref('')
const generationBrief = ref('')
const draft = reactive({
  id: 0,
  name: '',
  role: '',
  appearance: '',
  physique: '',
  default_personality: '',
  default_styling: '',
  image_url: '',
})
let editorVersion = 0

const filteredCharacters = computed(() => characters.value.filter(character =>
  `${character.name} ${character.role || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
))

function startNew() {
  editorVersion += 1
  Object.assign(draft, { id: 0, name: '', role: '', appearance: '', physique: '', default_personality: '', default_styling: '', image_url: '' })
}

function edit(character: GlobalCharacter) {
  editorVersion += 1
  Object.assign(draft, {
    id: character.id,
    name: character.name || '',
    role: character.role || '',
    appearance: character.appearance || '',
    physique: character.physique || '',
    default_personality: character.default_personality || '',
    default_styling: character.default_styling || '',
    image_url: character.image_url || '',
  })
}

async function load() {
  characters.value = await globalCharacterAPI.list() || []
}

async function save() {
  if (saving.value || !draft.name.trim()) return
  saving.value = true
  const submittedVersion = editorVersion
  const submittedDraft = { ...draft }
  const payload = {
    name: submittedDraft.name.trim(),
    role: submittedDraft.role,
    appearance: submittedDraft.appearance,
    physique: submittedDraft.physique,
    default_personality: submittedDraft.default_personality,
    default_styling: submittedDraft.default_styling,
    image_url: submittedDraft.image_url || null,
  }
  try {
    const saved = submittedDraft.id
      ? await globalCharacterAPI.update(submittedDraft.id, payload)
      : await globalCharacterAPI.create(payload)
    await load()
    if (editorVersion === submittedVersion) {
      const unchanged = Object.entries(submittedDraft).every(([key, value]) => draft[key as keyof typeof draft] === value)
      if (unchanged) edit(saved)
      else if (!submittedDraft.id) draft.id = saved.id
    }
    toast.success('全局角色已保存')
  } catch (error) {
    toastError(error, { fallback: '角色保存失败' })
  } finally {
    saving.value = false
  }
}

async function generate() {
  if (generating.value || !generationBrief.value.trim()) return
  generating.value = true
  try {
    const generated = await globalCharacterAPI.generate(generationBrief.value.trim())
    editorVersion += 1
    Object.assign(draft, {
      id: 0,
      name: generated.name || '',
      role: generated.role || '',
      appearance: generated.appearance || '',
      physique: generated.physique || '',
      default_personality: generated.default_personality || '',
      default_styling: generated.default_styling || '',
      image_url: generated.image_url || '',
    })
    toast.success('角色草稿已生成，可继续编辑后保存')
  } catch (error) {
    toastError(error, { fallback: '角色草稿生成失败' })
  } finally {
    generating.value = false
  }
}

async function remove() {
  if (!draft.id || saving.value || !window.confirm(`删除全局角色「${draft.name}」？已开始的世界不受影响。`)) return
  const characterId = draft.id
  saving.value = true
  try {
    await globalCharacterAPI.delete(characterId)
    characters.value = characters.value.filter(character => character.id !== characterId)
    if (draft.id === characterId) startNew()
    toast.success('全局角色已删除')
  } catch (error) {
    toastError(error, { fallback: '角色删除失败' })
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  try {
    await load()
  } catch (error) {
    toastError(error, { fallback: '全局角色库载入失败' })
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.character-library { height: 100%; overflow: auto; padding: 26px 32px 40px; color: var(--text-0); }
.page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; margin: 0 auto 22px; max-width: 1320px; }
.page-head h1 { margin: 3px 0 8px; font-size: 29px; line-height: 1.15; }
.eyebrow, .editor-kicker { color: var(--accent-text); font-size: 11px; font-weight: 700; }
.lede { max-width: 660px; color: var(--text-2); font-size: 13px; line-height: 1.6; }
.page-head .btn, .editor-actions .btn, .generation-tools .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.library-layout { display: grid; grid-template-columns: minmax(230px, 300px) minmax(0, 1fr); gap: 22px; max-width: 1320px; margin: 0 auto; align-items: start; }
.roster { min-width: 0; border-right: 1px solid var(--border); padding-right: 18px; }
.search-field { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 11px; color: var(--text-3); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 6px; }
.search-field input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-0); font: inherit; font-size: 13px; }
.roster-count { padding: 17px 4px 8px; color: var(--text-3); font-size: 11px; }
.roster-item { width: 100%; min-height: 60px; display: flex; align-items: center; gap: 11px; padding: 7px 9px; text-align: left; color: var(--text-0); background: transparent; border: 1px solid transparent; border-radius: 6px; cursor: pointer; }
.roster-item:hover { background: var(--bg-hover); }
.roster-item.active { background: var(--surface-raised); border-color: var(--border); }
.roster-item img, .avatar { width: 40px; height: 40px; flex: 0 0 40px; border-radius: 4px; object-fit: cover; background: var(--bg-2); }
.avatar { display: grid; place-items: center; color: var(--text-3); }
.roster-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.roster-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.roster-copy small { color: var(--text-3); font-size: 11px; }
.roster-chevron { color: var(--text-3); }
.empty-roster { padding: 22px 4px; color: var(--text-3); font-size: 13px; }
.editor { padding: 3px 0 0; }
.editor-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 17px; border-bottom: 1px solid var(--border); }
.editor-head h2 { margin-top: 3px; font-size: 20px; }
.generation-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 12px; padding: 16px 0 3px; }
.generation-tools textarea { width: 100%; color: var(--text-0); font: inherit; font-size: 13px; resize: vertical; }
.saved-mark { display: flex; align-items: center; gap: 6px; color: var(--success); font-size: 12px; }
.editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px 18px; padding: 19px 0; }
.field { display: flex; flex-direction: column; gap: 6px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.field-wide { grid-column: 1 / -1; }
.field .input { width: 100%; color: var(--text-0); font: inherit; font-weight: 400; font-size: 13px; }
.field textarea { resize: vertical; min-height: 62px; line-height: 1.55; }
.reference-preview { display: flex; align-items: center; gap: 10px; padding: 10px 0; color: var(--text-3); font-size: 12px; }
.reference-preview img { width: 62px; height: 62px; border: 1px solid var(--border); border-radius: 4px; object-fit: cover; }
.editor-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); }
.action-spacer { flex: 1; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 760px) {
  .character-library { padding: 20px 16px 32px; }
  .page-head { align-items: flex-start; flex-direction: column; }
  .library-layout { grid-template-columns: 1fr; }
  .roster { border-right: 0; border-bottom: 1px solid var(--border); padding: 0 0 14px; }
  .roster-item { width: 50%; display: inline-flex; vertical-align: top; }
}
@media (max-width: 480px) { .roster-item { width: 100%; } .editor-grid { grid-template-columns: 1fr; } .field-wide { grid-column: auto; } .generation-tools { grid-template-columns: 1fr; } }
</style>
