<template>
  <main class="character-library">
    <header class="page-head">
      <div>
        <p class="eyebrow">幻书 · 角色资料</p>
        <h1>全局角色库</h1>
        <p class="lede">保存这个人的固定外貌、身材，以及进入不同世界后会改写的默认生活。</p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="saving || generating || generatingImage" @click="startNew">
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
          :disabled="saving || generating || generatingImage"
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

      <form class="editor" @submit.prevent="!generatingImage && save()">
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
          <button class="btn" type="button" :disabled="saving || generating || generatingImage || !generationBrief.trim()" @click="generate">
            <Loader2 v-if="generating" :size="14" class="spin" />
            <WandSparkles v-else :size="14" />
            {{ generating ? '生成中' : '生成草稿' }}
          </button>
        </div>

        <section class="profile-group">
          <div>
            <h3>跨世界不变</h3>
            <p class="field-note">脸、身材和角色图进入任何世界都保持原样。</p>
          </div>
          <div class="reference-generator">
            <button
              v-if="draft.image_url"
              class="reference-preview"
              type="button"
              :aria-label="`预览${draft.name || '角色'}的角色参考图`"
              aria-haspopup="dialog"
              @click="openReferencePreview"
            >
              <img :src="publicMediaUrl(draft.image_url)" :alt="`${draft.name || '角色'}参考图`" />
              <span><Expand :size="14" /> 点击查看大图</span>
            </button>
            <div v-else class="reference-placeholder">
              <ImagePlus :size="26" />
              <span>生成后在此显示角色参考图</span>
            </div>
            <div class="reference-controls">
              <label class="field">
                <span>参考图视觉风格</span>
                <select v-model="imageStyle" class="input" :disabled="saving || generating || generatingImage || stylesLoading || !!styleLoadError || !stylePresets.length">
                  <option v-if="!stylePresets.length" value="">{{ stylesLoading ? '正在加载风格…' : '暂无可用风格' }}</option>
                  <option v-for="preset in stylePresets" :key="preset.value" :value="preset.value">{{ preset.name }}</option>
                </select>
                <span v-if="styleLoadError" class="field-note" role="alert">{{ styleLoadError }}</span>
                <span v-else-if="!stylesLoading && !stylePresets.length" class="field-note">暂无启用的视觉风格，请先到设置中启用风格预设。</span>
              </label>
              <button class="btn" type="button" :disabled="saving || generating || generatingImage || !draft.name.trim() || !canGenerateImage" @click="generatePortrait">
                <Loader2 v-if="generatingImage" :size="14" class="spin" />
                <ImagePlus v-else :size="14" />
                {{ generatingImage ? imageGenerationStage : '生成角色参考图' }}
              </button>
              <p class="field-note">左侧正脸特写，右侧正面、侧面、背面三张全身视图。生成前保存资料，完成后自动保存图片。</p>
            </div>
          </div>
          <div class="editor-grid">
            <label class="field field-wide">
              <span>固定外貌</span>
              <textarea v-model.trim="draft.appearance" class="input" rows="3" maxlength="2000" placeholder="年龄感、五官、发色、辨识度等稳定特征" />
            </label>
            <label class="field field-wide">
              <span>固定身材与体态</span>
              <textarea v-model.trim="draft.physique" class="input" rows="2" maxlength="2000" placeholder="身高、体型、体态等不随世界变化的特征" />
            </label>
            <label class="field field-wide">
              <span>参考形象地址</span>
              <input v-model.trim="draft.image_url" class="input" type="text" placeholder="https://… 或 /static/…" />
            </label>
          </div>
        </section>

        <section class="profile-group">
          <div>
            <h3>进入世界后会改变</h3>
            <p class="field-note">这些是默认值，进入不同世界后会单独改写。</p>
          </div>
          <div class="editor-grid">
            <label v-for="field in variableProfileFields" :key="field.key" class="field field-wide">
              <span>{{ field.label }}<small class="change-tag">随世界变化</small></span>
              <input v-if="field.short" v-model.trim="draft[field.key]" class="input" :maxlength="field.max" :placeholder="field.placeholder" :required="field.key === 'name'" />
              <textarea v-else v-model.trim="draft[field.key]" class="input" rows="3" :maxlength="field.max" :placeholder="field.placeholder" />
            </label>
          </div>
        </section>

        <footer class="editor-actions">
          <button v-if="draft.id" class="btn btn-danger" type="button" :disabled="saving || generating || generatingImage" @click="remove">
            <Trash2 :size="14" /> 删除角色
          </button>
          <span class="action-spacer"></span>
          <button class="btn" type="button" :disabled="saving || generating || generatingImage" @click="startNew">清空</button>
          <button class="btn btn-primary" type="submit" :disabled="saving || generating || generatingImage || !draft.name.trim()">
            <Loader2 v-if="saving" :size="14" class="spin" />
            <Save v-else :size="14" />
            {{ saving ? '保存中' : '保存角色' }}
          </button>
        </footer>
      </form>
    </div>

    <Teleport to="body">
      <dialog ref="referenceDialog" class="reference-dialog" aria-labelledby="reference-preview-title" @click.self="closeReferencePreview" @close="referencePreview = null">
        <header class="reference-dialog-head">
          <h2 id="reference-preview-title">{{ referencePreview?.title || '角色参考图' }}</h2>
          <button class="btn btn-ghost btn-icon" type="button" aria-label="关闭预览" autofocus @click="closeReferencePreview">
            <X :size="18" />
          </button>
        </header>
        <div class="reference-dialog-body">
          <img v-if="referencePreview" :src="referencePreview.src" :alt="referencePreview.title" />
        </div>
      </dialog>
    </Teleport>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ChevronRight, Expand, ImagePlus, Loader2, Plus, Save, Search, ShieldCheck, Trash2, UserRound, WandSparkles, X } from 'lucide-vue-next'
import { globalCharacterAPI, stylePresetAPI, taskAPI } from '~/composables/useApi'
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
  default_values?: string | null
  default_speech?: string | null
  default_habits?: string | null
  default_desires?: string | null
  default_fears?: string | null
  default_relationships?: string | null
  default_abilities?: string | null
  default_background?: string | null
  default_styling?: string | null
  image_url?: string | null
}

const variableProfileFields = [
  { key: 'name', label: '默认姓名', max: 80, short: true, placeholder: '角色姓名' },
  { key: 'role', label: '默认身份', max: 120, short: true, placeholder: '例如：调查记者' },
  { key: 'default_personality', label: '默认性格', max: 2000, placeholder: '处事方式和性格倾向' },
  { key: 'default_values', label: '默认价值观', max: 2000, placeholder: '这个人坚持或反对什么' },
  { key: 'default_speech', label: '默认说话方式', max: 2000, placeholder: '用词、语气、说与不说的习惯' },
  { key: 'default_habits', label: '默认习惯', max: 2000, placeholder: '日常动作、癖好和行事惯例' },
  { key: 'default_desires', label: '默认愿望', max: 2000, placeholder: '长期想得到或想完成的事' },
  { key: 'default_fears', label: '默认恐惧', max: 2000, placeholder: '害怕失去、面对或再次发生的事' },
  { key: 'default_relationships', label: '默认在乎的人', max: 2000, placeholder: '放不下的人，以及彼此的关系' },
  { key: 'default_abilities', label: '默认能力', max: 2000, placeholder: '擅长、不擅长和赖以生活的本事' },
  { key: 'default_background', label: '默认经历', max: 2000, placeholder: '形成这个人的经历' },
  { key: 'default_styling', label: '默认服装', max: 2000, placeholder: '作为跨世界适配起点的发型、服装和配饰' },
] as const

const characters = ref<GlobalCharacter[]>([])
const loading = ref(true)
const saving = ref(false)
const generating = ref(false)
const generatingImage = ref(false)
const imageGenerationStage = ref('')
const stylePresets = ref<Array<{ name: string; value: string }>>([])
const imageStyle = ref('')
const stylesLoading = ref(true)
const styleLoadError = ref('')
const canGenerateImage = computed(() => !stylesLoading.value && !styleLoadError.value && stylePresets.value.some(preset => preset.value === imageStyle.value))
const query = ref('')
const generationBrief = ref('')
const referenceDialog = ref<HTMLDialogElement | null>(null)
const referencePreview = ref<{ src: string; title: string } | null>(null)
const draft = reactive({
  id: 0,
  name: '',
  role: '',
  appearance: '',
  physique: '',
  default_personality: '',
  default_values: '',
  default_speech: '',
  default_habits: '',
  default_desires: '',
  default_fears: '',
  default_relationships: '',
  default_abilities: '',
  default_background: '',
  default_styling: '',
  image_url: '',
})
let editorVersion = 0
let savedImageUrl = ''
let disposed = false
let imagePollTimer: ReturnType<typeof setTimeout> | undefined
let releaseImagePoll: (() => void) | undefined

onBeforeUnmount(() => {
  disposed = true
  if (imagePollTimer !== undefined) clearTimeout(imagePollTimer)
  releaseImagePoll?.()
})

function waitForImagePoll() {
  return new Promise<void>(resolve => {
    releaseImagePoll = resolve
    imagePollTimer = setTimeout(() => {
      imagePollTimer = undefined
      releaseImagePoll = undefined
      resolve()
    }, 2000)
  })
}

const filteredCharacters = computed(() => characters.value.filter(character =>
  `${character.name} ${character.role || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()),
))

function openReferencePreview() {
  if (!draft.image_url || !referenceDialog.value) return
  referencePreview.value = { src: publicMediaUrl(draft.image_url), title: `${draft.name || '角色'} · 角色参考图` }
  referenceDialog.value.showModal()
}

function closeReferencePreview() {
  referenceDialog.value?.close()
}

function startNew() {
  editorVersion += 1
  savedImageUrl = ''
  Object.assign(draft, {
    id: 0,
    appearance: '',
    physique: '',
    image_url: '',
    ...Object.fromEntries(variableProfileFields.map(field => [field.key, ''])),
  })
}

function edit(character: GlobalCharacter) {
  editorVersion += 1
  savedImageUrl = character.image_url || ''
  Object.assign(draft, {
    id: character.id,
    name: character.name || '',
    role: character.role || '',
    appearance: character.appearance || '',
    physique: character.physique || '',
    image_url: character.image_url || '',
    ...Object.fromEntries(variableProfileFields.map(field => [field.key, character[field.key] || ''])),
  })
}

async function load() {
  const loaded = await globalCharacterAPI.list() || []
  if (!disposed) characters.value = loaded
}

async function loadStyles() {
  stylesLoading.value = true
  styleLoadError.value = ''
  try {
    const presets = await stylePresetAPI.list() || []
    if (disposed) return
    stylePresets.value = presets
    if (!presets.some(preset => preset.value === imageStyle.value)) imageStyle.value = presets[0]?.value || ''
  } catch {
    if (!disposed) {
      stylePresets.value = []
      imageStyle.value = ''
      styleLoadError.value = '视觉风格加载失败，请刷新页面后重试。'
    }
  } finally {
    if (!disposed) stylesLoading.value = false
  }
}

async function save(): Promise<GlobalCharacter | null> {
  if (disposed || saving.value || generating.value || !draft.name.trim()) return null
  saving.value = true
  const submittedVersion = editorVersion
  const submittedDraft = { ...draft }
  const payload = {
    ...Object.fromEntries(variableProfileFields.map(field => [field.key, submittedDraft[field.key]])),
    name: submittedDraft.name.trim(),
    appearance: submittedDraft.appearance,
    physique: submittedDraft.physique,
    // 后台生图可能在草稿载入后更新图片；未手动修改时不提交旧地址。
    ...(!submittedDraft.id || submittedDraft.image_url !== savedImageUrl
      ? { image_url: submittedDraft.image_url || null }
      : {}),
  }
  try {
    const saved = submittedDraft.id
      ? await globalCharacterAPI.update(submittedDraft.id, payload)
      : await globalCharacterAPI.create(payload)
    if (disposed) return null
    await load()
    if (disposed) return null
    if (editorVersion === submittedVersion) {
      const unchanged = Object.entries(submittedDraft).every(([key, value]) => draft[key as keyof typeof draft] === value)
      if (unchanged) edit(saved)
      else {
        if (!submittedDraft.id) draft.id = saved.id
        savedImageUrl = saved.image_url || ''
        if (draft.image_url === submittedDraft.image_url) draft.image_url = savedImageUrl
      }
    }
    toast.success('全局角色已保存')
    return saved
  } catch (error) {
    if (!disposed) toastError(error, { fallback: '角色保存失败' })
    return null
  } finally {
    if (!disposed) saving.value = false
  }
}

async function generatePortrait() {
  if (disposed || generatingImage.value || generating.value || saving.value || !draft.name.trim() || !canGenerateImage.value) return
  const style = imageStyle.value
  generatingImage.value = true
  imageGenerationStage.value = '保存角色资料…'
  try {
    const saved = await save()
    if (disposed || !saved?.id) return
    const submittedVersion = editorVersion
    imageGenerationStage.value = '准备参考图提示词…'
    const result = await globalCharacterAPI.generateImage(saved.id, style)
    if (disposed) return
    const taskId = Number(result?.image_generation_id)
    if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('图片任务没有提交')
    imageGenerationStage.value = '角色参考图生成中'

    const deadline = Date.now() + 600_000
    while (!disposed && Date.now() < deadline) {
      const task = await taskAPI.get(taskId)
      if (disposed) return
      if (task?.status === 'completed') {
        await load()
        if (disposed) return
        const updated = characters.value.find(character => character.id === saved.id)
        if (editorVersion === submittedVersion && draft.id === saved.id && updated) {
          if (draft.image_url === savedImageUrl) draft.image_url = updated.image_url || ''
          savedImageUrl = updated.image_url || ''
        }
        const generatedImageUrl = publicMediaUrl(task.localPath || task.resultUrl)
        if (!generatedImageUrl || generatedImageUrl !== publicMediaUrl(updated?.image_url)) {
          toast.warning(updated
            ? '角色信息或图片已变化，本次生成图未应用，可检查资料后重新生成'
            : '角色已删除，本次生成图未应用', generatedImageUrl ? {
            action: {
              label: '查看生成图',
              onClick: () => window.open(generatedImageUrl, '_blank', 'noopener,noreferrer'),
            },
          } : undefined)
          return
        }
        toast.success('角色参考图已生成，可在后续世界中复用')
        return
      }
      if (!task || task.status === 'failed') throw new Error(task?.errorMsg || '角色图生成失败')
      await waitForImagePoll()
    }
    if (!disposed) throw new Error('角色图生成超时，可稍后重新打开角色库查看')
  } catch (error) {
    if (!disposed) toastError(error, { fallback: '角色图生成失败' })
  } finally {
    if (!disposed) {
      generatingImage.value = false
      imageGenerationStage.value = ''
    }
  }
}

async function generate() {
  if (disposed || saving.value || generating.value || generatingImage.value || !generationBrief.value.trim()) return
  generating.value = true
  try {
    const generated = await globalCharacterAPI.generate(generationBrief.value.trim())
    if (disposed) return
    editorVersion += 1
    Object.assign(draft, {
      id: 0,
      name: generated.name || '',
      role: generated.role || '',
      appearance: generated.appearance || '',
      physique: generated.physique || '',
      image_url: generated.image_url || '',
      ...Object.fromEntries(variableProfileFields.map(field => [field.key, generated[field.key] || ''])),
    })
    toast.success('角色草稿已生成，可继续编辑后保存')
  } catch (error) {
    if (!disposed) toastError(error, { fallback: '角色草稿生成失败' })
  } finally {
    if (!disposed) generating.value = false
  }
}

async function remove() {
  if (disposed || !draft.id || saving.value || generating.value || generatingImage.value || !window.confirm(`删除全局角色「${draft.name}」？已开始的世界不受影响。`)) return
  const characterId = draft.id
  saving.value = true
  try {
    await globalCharacterAPI.delete(characterId)
    if (disposed) return
    characters.value = characters.value.filter(character => character.id !== characterId)
    if (draft.id === characterId) startNew()
    toast.success('全局角色已删除')
  } catch (error) {
    if (!disposed) toastError(error, { fallback: '角色删除失败' })
  } finally {
    if (!disposed) saving.value = false
  }
}

onMounted(async () => {
  try {
    await Promise.all([load(), loadStyles()])
  } catch (error) {
    if (!disposed) toastError(error, { fallback: '全局角色库载入失败' })
  } finally {
    if (!disposed) loading.value = false
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
.profile-group { display: grid; gap: 14px; padding-top: 18px; }
.reference-generator { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; gap: 18px; }
.reference-controls { display: grid; gap: 12px; }
.reference-controls > .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; justify-self: start; }
.profile-group h3 { margin: 0; font-size: 15px; }
.field-note { margin: 0; color: var(--text-2); font-size: 13px; font-weight: 400; line-height: 1.6; }
.change-tag { margin-left: 8px; color: var(--text-3); font-size: 12px; font-weight: 400; }
.editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px 18px; padding: 19px 0; }
.field { display: flex; flex-direction: column; gap: 6px; color: var(--text-2); font-size: 12px; font-weight: 600; }
.field-wide { grid-column: 1 / -1; }
.field .input { width: 100%; color: var(--text-0); font: inherit; font-weight: 400; font-size: 13px; }
.field textarea { resize: vertical; min-height: 62px; line-height: 1.55; }
.reference-preview, .reference-placeholder { width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-raised); }
.reference-preview { position: relative; display: block; padding: 0; overflow: hidden; cursor: zoom-in; }
.reference-preview img { display: block; width: 100%; height: 100%; object-fit: contain; }
.reference-preview span { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; color: #fff; background: rgba(0, 0, 0, 0.65); border-radius: 4px; font-size: 12px; }
.reference-preview:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.reference-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); font-size: 12px; }
.reference-dialog { width: min(1200px, calc(100vw - 40px)); max-width: none; max-height: calc(100dvh - 40px); margin: auto; padding: 0; color: var(--text-0); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 10px; }
.reference-dialog::backdrop { background: rgba(0, 0, 0, 0.75); }
.reference-dialog-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.reference-dialog-head h2 { margin: 0; font-size: 15px; }
.reference-dialog-body { display: flex; align-items: center; justify-content: center; padding: 16px; }
.reference-dialog-body img { display: block; max-width: 100%; max-height: calc(100dvh - 132px); object-fit: contain; }
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
  .reference-generator { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 480px) { .roster-item { width: 100%; } .editor-grid { grid-template-columns: 1fr; } .field-wide { grid-column: auto; } .generation-tools { grid-template-columns: 1fr; } }
</style>
