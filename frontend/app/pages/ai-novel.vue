<template>
  <div class="ai-novel-page">
    <iframe
      v-if="ready"
      :key="frameKey"
      class="frame"
      src="/ai-novel-app/"
      :title="t('layout.aiNovelPage.frameTitle')"
    />
    <div v-else class="status">
      <div class="status-card">
        <p v-if="connecting" class="dim">{{ t('layout.aiNovelPage.connecting') }}</p>
        <template v-else>
          <h1>{{ t('layout.aiNovelPage.unavailable') }}</h1>
          <p class="dim">{{ t('layout.aiNovelPage.hint') }}</p>
          <p v-if="message" class="detail">{{ message }}</p>
          <code class="command">{{ t('layout.aiNovelPage.command') }}</code>
          <div>
            <button class="btn btn-primary" type="button" @click="retry">{{ t('layout.aiNovelPage.retry') }}</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
useHead(() => ({ title: t('layout.nav.aiNovel') }))

const ready = ref(false)
const connecting = ref(true)
const message = ref('')
const frameKey = ref(0)

type SidecarStatus = {
  running?: boolean
  message?: string
}

async function readStatus(response: Response): Promise<SidecarStatus> {
  return await response.json().catch(() => ({})) as SidecarStatus
}

async function refresh() {
  connecting.value = true
  ready.value = false
  try {
    const response = await fetch('/api/v1/ai-novel/status', { cache: 'no-store' })
    const payload = await readStatus(response)
    message.value = payload.message || ''
    if (response.ok && payload.running) {
      frameKey.value += 1
      ready.value = true
    }
  } catch {
    message.value = ''
  } finally {
    connecting.value = false
  }
}

async function retry() {
  connecting.value = true
  ready.value = false
  try {
    const response = await fetch('/api/v1/ai-novel/start', { method: 'POST', cache: 'no-store' })
    const payload = await readStatus(response)
    message.value = payload.message || ''
    if (response.ok && payload.running) {
      frameKey.value += 1
      ready.value = true
    }
  } catch {
    message.value = ''
  } finally {
    connecting.value = false
  }
}

onMounted(refresh)
</script>

<style scoped>
.ai-novel-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.frame {
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #f6f1e8;
}
.status {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}
.status-card {
  width: min(520px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.status-card h1 {
  margin: 0;
  font-size: 22px;
  line-height: 1.3;
}
.detail {
  margin: 0;
  color: var(--warn-text, var(--text-2));
  white-space: pre-wrap;
}
.command {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text-1);
}
</style>
