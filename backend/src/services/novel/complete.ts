/**
 * 织界小说的模型调用是一条 user 消息的 chat completion，没有工具。
 * 这里走已经配好的文本服务，并套上制作台同一套关思考补丁，避免中转站把章节写到一半掐掉。
 * 长生成用流式响应再拼回全文，避免非流式请求被中间代理空闲超时（524）掐断。
 * 调用方拿到的仍是完整字符串。
 */
import { getTextConfig, getTextProviderBaseUrl, type AIConfig } from '../ai.js'
import { installCodeccUserAgentFetch, installThinkingOffFetch } from '../../agents/thinking-off.js'
import { logTaskWarn } from '../../utils/task-logger.js'
import { NOVEL_MAX_TOKENS } from './generator.js'

/** 文本服务若单独配了温度，以服务配置为准；否则用 0.7。 */
const NOVEL_TEMPERATURE = 0.7
const NOVEL_TIMEOUT_MS = 600_000
/** 524、空正文，以及流里的 upstream_error，各再试一次。长生成一次就要一两分钟，不再加次数。 */
const NOVEL_COMPLETION_ATTEMPTS = 2
const NOVEL_COMPLETION_RETRY_DELAY_MS = 500
const EMPTY_NOVEL_RESULT = '小说章节没有写出来'

export interface NovelCompletionDependencies {
  config: AIConfig
  fetchImpl: typeof fetch
}

/** 调用方只传 prompt。deps 只给测试注入文本配置和 fetch。 */
export async function completeNovelPrompt(prompt: string, deps?: NovelCompletionDependencies): Promise<string> {
  const config = deps?.config ?? await getTextConfig()
  const provider = config.provider.toLowerCase()
  const baseURL = getTextProviderBaseUrl(config)
  const temperature = config.temperature ?? NOVEL_TEMPERATURE
  const outbound = installCodeccUserAgentFetch(deps?.fetchImpl)
  const patched = installThinkingOffFetch({
    providerName: provider,
    baseURL,
    enabled: (process.env.AI_DISABLE_THINKING ?? 'true').toLowerCase() !== 'false',
    patchRaw: process.env.AI_THINKING_OFF_PATCH,
    fetchImpl: outbound,
  })
  const call = patched || outbound
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
  const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`
  return completeWithRetry(async () => {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      stream: true,
    }
    if (!/api\.openai\.com/.test(baseURL)) body.max_tokens = NOVEL_MAX_TOKENS
    const response = await call(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NOVEL_TIMEOUT_MS),
    })
    if (!response.ok) {
      const status = response.status
      await discardResponseBody(response)
      throw new Error(`小说章节生成失败（${status}）`)
    }
    return requireNovelText(assembleChatCompletionText(await response.text()))
  })
}

async function completeGemini(
  call: typeof fetch,
  baseURL: string,
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number,
): Promise<string> {
  const root = `${baseURL.replace(/\/+$/, '')}/models/${encodeURIComponent(model)}`
  const streamUrl = `${root}:streamGenerateContent?alt=sse`
  const plainUrl = `${root}:generateContent`
  return completeWithRetry(async () => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: NOVEL_MAX_TOKENS },
    })
    const signal = AbortSignal.timeout(NOVEL_TIMEOUT_MS)
    let response = await call(streamUrl, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: payload,
      signal,
    })
    if (response.status === 404) {
      await discardResponseBody(response)
      response = await call(plainUrl, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal,
      })
    }
    if (!response.ok) {
      const status = response.status
      await discardResponseBody(response)
      throw new Error(`小说章节生成失败（${status}）`)
    }
    return requireNovelText(assembleGeminiCompletionText(await response.text()))
  })
}

async function completeWithRetry(run: () => Promise<string>): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= NOVEL_COMPLETION_ATTEMPTS; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      const reason = novelRetryReason(error)
      if (!reason || attempt >= NOVEL_COMPLETION_ATTEMPTS) throw error
      logTaskWarn('Novel', 'completion-retry', { reason, attempt })
      await delay(NOVEL_COMPLETION_RETRY_DELAY_MS)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(EMPTY_NOVEL_RESULT)
}

/** 流里没有状态码的 upstream_error。message 留给调用方看上游原文。 */
class NovelUpstreamError extends Error {
  constructor(detail: string) {
    super(detail ? `小说章节生成失败：${detail}` : '小说章节生成失败')
    this.name = 'NovelUpstreamError'
  }
}

function novelRetryReason(error: unknown): '524' | 'empty' | 'upstream' | null {
  if (error instanceof NovelUpstreamError) return 'upstream'
  if (!(error instanceof Error)) return null
  if (error.message === EMPTY_NOVEL_RESULT) return 'empty'
  if (error.message === '小说章节生成失败（524）') return '524'
  return null
}

function requireNovelText(text: string): string {
  if (!text.trim()) throw new Error(EMPTY_NOVEL_RESULT)
  return text
}

async function discardResponseBody(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // 状态码已经说明失败原因。
  }
}

function delay(milliseconds: number) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds)
  })
}

function assembleChatCompletionText(raw: string): string {
  return assembleCompletionText(raw, textFromChatEvent)
}

function assembleGeminiCompletionText(raw: string): string {
  return assembleCompletionText(raw, textFromGeminiEvent)
}

function assembleCompletionText(raw: string, fromEvent: (payload: unknown) => string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (looksLikeSse(trimmed)) return textFromSse(trimmed, fromEvent)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return textFromJson(trimmed, fromEvent)
  throw new Error('小说章节生成失败')
}

function looksLikeSse(trimmed: string) {
  return trimmed.startsWith('data:') || trimmed.startsWith('event:') || trimmed.startsWith(':')
}

function textFromSse(raw: string, fromEvent: (payload: unknown) => string): string {
  let text = ''
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    text += fromEvent(payload)
  }
  return text
}

function textFromJson(raw: string, fromEvent: (payload: unknown) => string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('小说章节生成失败')
  }
  return fromEvent(parsed)
}

function textFromChatEvent(payload: unknown): string {
  if (Array.isArray(payload)) return payload.map(textFromChatEvent).join('')
  throwIfPayloadError(payload)
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return ''
  return textFromChatChoice(choices[0])
}

function textFromChatChoice(choice: unknown): string {
  if (!choice || typeof choice !== 'object') return ''
  const record = choice as {
    delta?: { content?: unknown }
    message?: { content?: unknown }
  }
  if (record.delta && typeof record.delta === 'object' && 'content' in record.delta) {
    return contentText(record.delta.content)
  }
  return contentText(record.message?.content)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => (
    typeof part === 'string'
      ? part
      : part && typeof part === 'object' && 'text' in part
        ? String((part as { text?: unknown }).text || '')
        : ''
  )).join('')
}

function textFromGeminiEvent(payload: unknown): string {
  if (Array.isArray(payload)) return payload.map(textFromGeminiEvent).join('')
  throwIfPayloadError(payload)
  if (!payload || typeof payload !== 'object') return ''
  const candidates = (payload as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return ''
  const first = candidates[0] as { content?: { parts?: Array<{ text?: string; thought?: boolean }> } } | undefined
  const parts = first?.content?.parts || []
  return parts.filter(part => part && !part.thought && part.text).map(part => part.text).join('')
}

function throwIfPayloadError(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('error' in payload)) return
  const error = (payload as { error?: unknown }).error
  if (error == null) return
  const status = httpStatusFromError(error)
  if (status) throw new Error(`小说章节生成失败（${status}）`)
  if (isUpstreamPayloadError(error)) throw new NovelUpstreamError(errorDetail(error))
  throw new Error('小说章节生成失败')
}

function isUpstreamPayloadError(error: unknown) {
  return !!error && typeof error === 'object' && (error as { type?: unknown }).type === 'upstream_error'
}

function errorDetail(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return ''
  return message.replace(/\s+/g, ' ').trim()
}

function httpStatusFromError(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const record = error as { status?: unknown; code?: unknown }
  for (const value of [record.code, record.status]) {
    const numeric = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{3}$/.test(value)
        ? Number(value)
        : NaN
    if (Number.isInteger(numeric) && numeric >= 400 && numeric <= 599) return numeric
  }
  return null
}
