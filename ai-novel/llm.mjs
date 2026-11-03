/**
 * OpenAI 兼容的 chat completion。密钥只从环境变量读取，不写进仓库。
 */

const TIMEOUT_MS = 600_000

export function novelModelConfig() {
  const baseUrl = (process.env.AI_NOVEL_BASE_URL || '').trim()
  const apiKey = (process.env.AI_NOVEL_API_KEY || '').trim()
  const model = (process.env.AI_NOVEL_MODEL || '').trim()
  return { baseUrl, apiKey, model }
}

export function assertNovelModelConfig() {
  const config = novelModelConfig()
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error('请配置模型地址、密钥和模型名')
  }
  return config
}

function chatUrl(baseUrl) {
  const root = baseUrl.replace(/\/+$/, '')
  if (root.endsWith('/chat/completions')) return root
  if (root.endsWith('/v1')) return `${root}/chat/completions`
  return `${root}/v1/chat/completions`
}

export async function completeChat(prompt) {
  const config = assertNovelModelConfig()
  const response = await fetch(chatUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error('模型请求失败')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('模型没有返回 JSON')
  }
  const content = parsed.choices?.[0]?.message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
      : ''
  if (!text.trim()) throw new Error('模型没有写出内容')
  return text
}
