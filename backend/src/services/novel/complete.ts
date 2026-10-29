/**
 * 火宝小说的模型调用是一条 user 消息的 chat completion，没有工具。
 * 这里走短剧已经配好的文本服务，并套上制作台同一套关思考补丁，避免中转站把章节写到一半掐掉。
 */
import { getTextConfig, getTextProviderBaseUrl } from '../ai.js'
import { installThinkingOffFetch } from '../../agents/thinking-off.js'

/** 火宝小说设置页的默认温度。文本服务若单独配了温度，以服务配置为准。 */
const NOVEL_TEMPERATURE = 0.7
/** 与工作室 Agent 相同的输出上限，保证大约 3000 字的章节不会被默认 8192 截断。 */
const NOVEL_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16384)
const NOVEL_TIMEOUT_MS = 600_000

export async function completeNovelPrompt(prompt: string): Promise<string> {
  const config = await getTextConfig()
  const provider = config.provider.toLowerCase()
  const baseURL = getTextProviderBaseUrl(config)
  const temperature = config.temperature ?? NOVEL_TEMPERATURE
  const patched = installThinkingOffFetch({
    providerName: provider,
    baseURL,
    enabled: (process.env.AI_DISABLE_THINKING ?? 'true').toLowerCase() !== 'false',
    patchRaw: process.env.AI_THINKING_OFF_PATCH,
  })
  const call = patched || fetch
  if (provider === 'gemini') return completeGemini(call, baseURL, config.apiKey, config.model, prompt, temperature)
  return completeChat(call, baseURL, config.apiKey, config.model, prompt, temperature)
}

async function completeChat(
  call: typeof fetch,
  baseURL: string,
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  }
  if (!/api\.openai\.com/.test(baseURL)) body.max_tokens = NOVEL_MAX_TOKENS
  const response = await call(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NOVEL_TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`小说章节生成失败（${response.status}）`)
  const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = parsed.choices?.[0]?.message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => typeof part === 'string' ? part : (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text || '') : '')).join('')
      : ''
  if (!text.trim()) throw new Error('小说章节没有写出来')
  return text
}

async function completeGemini(
  call: typeof fetch,
  baseURL: string,
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  const url = `${baseURL.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`
  const response = await call(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: NOVEL_MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(NOVEL_TIMEOUT_MS),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`小说章节生成失败（${response.status}）`)
  const parsed = JSON.parse(raw) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  }
  const parts = parsed.candidates?.[0]?.content?.parts || []
  const text = parts.filter(part => part && !part.thought && part.text).map(part => part.text).join('')
  if (!text.trim()) throw new Error('小说章节没有写出来')
  return text
}
