<template>
  <div class="page lobby">
    <header class="lobby-head">
      <p class="eyebrow">小说创作</p>
      <h1>起一本书</h1>
      <p class="lede">
        按原稿写。先生成架构和整本大纲，再一章一章写下去。每一章都可以生成剧情图和剧情视频。
      </p>
    </header>

    <section class="panel">
      <form class="book-form" @submit.prevent="startBook">
        <label class="field">
          <span class="field-label">书名</span>
          <input v-model.trim="form.title" class="input" maxlength="40" placeholder="例如：雾隐茶寮" required />
        </label>
        <label class="field">
          <span class="field-label">类型</span>
          <input v-model.trim="form.genre" class="input" maxlength="20" placeholder="悬疑、言情、玄幻…" />
        </label>
        <label class="field field-wide">
          <span class="field-label">主题</span>
          <textarea v-model.trim="form.topic" class="input" rows="4" maxlength="2000" placeholder="这本书讲什么。谁遇上了什么事，世界是什么样。" required></textarea>
        </label>
        <label class="field field-wide">
          <span class="field-label">内容指导</span>
          <textarea v-model.trim="form.userGuidance" class="input" rows="3" maxlength="2000" placeholder="可留空。这里的话会原样作为用户指导，写进架构、大纲和章节。"></textarea>
        </label>
        <label class="field">
          <span class="field-label">章节数</span>
          <input v-model.number="form.numberOfChapters" class="input" type="number" min="1" max="200" required />
        </label>
        <label class="field">
          <span class="field-label">每章字数</span>
          <input v-model.number="form.wordNumber" class="input" type="number" min="200" max="8000" required />
        </label>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="starting">起书</button>
        </div>
      </form>
    </section>

    <section v-if="books.length" class="continues">
      <h2>接着写</h2>
      <div class="continue-row">
        <button
          v-for="item in books"
          :key="item.id"
          class="continue-card"
          type="button"
          @click="navigateTo(`/novel/${item.id}`)"
        >
          <strong>{{ item.title }}</strong>
          <span class="dim">{{ item.written_chapters || 0 }} / {{ item.number_of_chapters }} 章</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { novelAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const books = ref<any[]>([])
const starting = ref(false)
const form = reactive({
  title: '',
  genre: '',
  topic: '',
  userGuidance: '',
  numberOfChapters: 100,
  wordNumber: 3000,
})

useHead({ title: '小说创作 · 织界' })

async function load() {
  books.value = await novelAPI.books() || []
}

async function startBook() {
  if (starting.value) return
  starting.value = true
  try {
    const book = await novelAPI.createBook({
      title: form.title,
      genre: form.genre,
      topic: form.topic,
      user_guidance: form.userGuidance,
      number_of_chapters: form.numberOfChapters,
      word_number: form.wordNumber,
    })
    await navigateTo(`/novel/${book.id}`)
  } catch (error) {
    toastError(error, { fallback: '这本书没有建起来' })
  } finally {
    starting.value = false
  }
}

onMounted(async () => {
  try {
    await load()
  } catch (error) {
    toastError(error, { fallback: '书单没有载入' })
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
.lobby-head h1, .continues h2 {
  font-family: "Iowan Old Style", "Palatino Linotype", "Songti SC", "Noto Serif SC", serif;
  letter-spacing: -0.03em;
}
.lobby-head h1 { font-size: 48px; line-height: 1; margin: 8px 0 12px; }
.lede { max-width: 680px; color: var(--text-2); font-size: 15px; line-height: 1.7; }
.panel, .continue-card {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: var(--shadow-xs);
}
.panel { padding: 20px; }
.book-form { display: grid; grid-template-columns: 1fr 180px; gap: 12px; }
.field-wide, .form-actions { grid-column: 1 / -1; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 650; color: var(--text-2); }
textarea.input { resize: vertical; min-height: 88px; line-height: 1.6; padding: 10px 12px; }
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
@media (max-width: 980px) {
  .book-form { grid-template-columns: 1fr; }
  .lobby-head h1 { font-size: 38px; }
}
</style>
