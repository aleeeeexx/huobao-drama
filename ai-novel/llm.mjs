/**
 * 小说模块的文本生成。
 * 默认使用织界已启用的文本模型（baseURL、apiKey、model）。
 * AI_NOVEL_BASE_URL / AI_NOVEL_API_KEY / AI_NOVEL_MODEL 三个都有值时整套覆盖，按 OpenAI chat completions 调用。
 * 只设置其中一部分时，缺的字段从织界配置补上，协议仍跟随织界的 provider。
 */
import { joinProviderUrl, readHuobaoTextConfig } from './huobao-config.mjs'

const TIMEOUT_MS = 600_000
const DEFAULT_TEMPERATURE = 0.7

function envValue(name) {
  return (process.env[name] || '').trim()
}

export function novelModelConfig() {
  const envBaseUrl = envValue('AI_NOVEL_BASE_URL')
  const envApiKey = envValue('AI_NOVEL_API_KEY')
  const envModel = envValue('AI_NOVEL_MODEL')
  if (envBaseUrl && envApiKey && envModel) {
    return {
      provider: 'openai',
      baseUrl: envBaseUrl,
      apiKey: envApiKey,
      model: envModel,
      temperature: null,
      source: 'env',
    }
  }

  const huobao = readHuobaoTextConfig()
  return {
    provider: huobao?.provider || 'openai',
    baseUrl: envBaseUrl || huobao?.baseUrl || '',
    apiKey: envApiKey || huobao?.apiKey || '',
    model: envModel || huobao?.model || '',
    temperature: huobao?.temperature ?? null,
    source: huobao ? 'huobao' : 'missing',
  }
}

export function assertNovelModelConfig() {
  const config = novelModelConfig()
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error('请先在织界设置页启用文本模型，或同时设置 AI_NOVEL_BASE_URL、AI_NOVEL_API_KEY、AI_NOVEL_MODEL')
  }
  return config
}

function legacyChatUrl(baseUrl) {
  const root = baseUrl.replace(/\/+$/, '')
  if (root.endsWith('/chat/completions')) return root
  if (root.endsWith('/v1')) return `${root}/chat/completions`
  return `${root}/v1/chat/completions`
}

export function novelChatUrl(config) {
  const provider = (config.provider || 'openai').toLowerCase()
  if (provider === 'gemini') {
    return joinProviderUrl(config.baseUrl, '/v1beta', `/models/${encodeURIComponent(config.model)}:generateContent`)
  }
  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '/chat/completions')
  }
  return legacyChatUrl(config.baseUrl)
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
}

async function readModelPayload(response) {
  const raw = await response.text()
  if (!response.ok) throw new Error('模型请求失败')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('模型没有返回 JSON')
  }
}

export async function completeChat(prompt) {
  const config = assertNovelModelConfig()
  if (config.provider === 'gemini') return completeGemini(config, prompt)
  return completeOpenAI(config, prompt)
}

async function completeOpenAI(config, prompt) {
  const response = await fetch(novelChatUrl(config), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const parsed = await readModelPayload(response)
  const text = messageText(parsed.choices?.[0]?.message?.content)
  if (!text.trim()) throw new Error('模型没有写出内容')
  return text
}

async function completeGemini(config, prompt) {
  const response = await fetch(novelChatUrl(config), {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: config.temperature ?? DEFAULT_TEMPERATURE },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const parsed = await readModelPayload(response)
  const parts = parsed.candidates?.[0]?.content?.parts || []
  const text = parts.filter(part => part && !part.thought && part.text).map(part => part.text).join('')
  if (!text.trim()) throw new Error('模型没有写出内容')
  return text
}
