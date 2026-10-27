/**
 * 关闭思考(thinking)的请求补丁。
 *
 * new-api 类中转站对 thinking 模型强制要求多轮请求回传 reasoning_content,
 * Agent 多轮工具调用无法回传,会被 400 拒绝。这里给非官方端点注入关思考参数。
 *
 * 不能把所有厂商字段一股脑发给每个网关:
 * reasoning_effort:"none" 是给 Gemini 兼容渠道把思考预算打成 0 的。
 * codecc 会把这个字段原样转给上游;Grok / xAI 不接受 "none",
 * 单独带上它就会 HTTP 500(Upstream gateway error),去掉后同一请求返回 200。
 * 官方 OpenAI / Gemini 端点不注入(官方会拒绝未知参数)。
 */
import { logTaskWarn } from '../utils/task-logger.js'

export const DEFAULT_OPENAI_THINKING_OFF_PATCH: Record<string, unknown> = {
  thinking: { type: 'disabled' }, // new-api 通用 / DeepSeek
  enable_thinking: false, // Qwen / 阿里系
  reasoning_effort: 'none', // OpenAI 风格枚举(Gemini 渠道映射为 budget 0)
}

export interface ThinkingOffState {
  /** 上游已拒绝 reasoning_effort:"none" 的 host|model,后续请求直接不带 */
  rejected: Set<string>
  noted: Set<string>
}

const sharedState: ThinkingOffState = {
  rejected: new Set<string>(),
  noted: new Set<string>(),
}

export function isOfficialTextHost(baseURL: string) {
  return /api\.openai\.com|generativelanguage\.googleapis\.com/.test(baseURL)
}

export function thinkingOffHostKey(baseURL: string) {
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return baseURL.trim().toLowerCase()
  }
}

/** codecc 网关不接受 reasoning_effort:"none"(含子域名,不含仿冒域名)。 */
export function isCodeccHost(baseURL: string) {
  const host = thinkingOffHostKey(baseURL)
  return host === 'codecc.cc' || host.endsWith('.codecc.cc')
}

/**
 * xAI / Grok 拒绝 reasoning_effort:"none"(以及 "max")。
 * 按模型族判断,不写死某一个版本号。
 */
export function modelRejectsReasoningEffortNone(model: string | undefined | null) {
  const name = String(model || '').trim().toLowerCase()
  if (!name) return false
  return name === 'grok' || /(^|\/)grok([\-.]|$)/.test(name)
}

export function parseThinkingOffPatch(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return { ...DEFAULT_OPENAI_THINKING_OFF_PATCH }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_OPENAI_THINKING_OFF_PATCH }
    }
    return parsed as Record<string, unknown>
  } catch {
    return { ...DEFAULT_OPENAI_THINKING_OFF_PATCH }
  }
}

function rejectionKey(baseURL: string, model: string) {
  return `${thinkingOffHostKey(baseURL)}|${model.trim().toLowerCase()}`
}

export function shouldOmitReasoningEffortNone(
  baseURL: string,
  model: string | undefined,
  state: ThinkingOffState = sharedState,
) {
  const name = String(model || '')
  if (state.rejected.has(rejectionKey(baseURL, name))) return true
  if (isCodeccHost(baseURL)) return true
  return modelRejectsReasoningEffortNone(name)
}

/**
 * 网关没点名字段时,codecc 的典型回包是 HTTP 500 "Upstream gateway error"。
 * xAI 直连则是 "Invalid reasoning effort"。这两种才重试;过载/鉴权/限流不重试。
 */
export function isUnsupportedReasoningEffortError(status: number, bodyText: string) {
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429) return false
  const text = bodyText.toLowerCase()
  if (/invalid reasoning effort/.test(text)) return true
  if (/reasoning_effort/.test(text) && /unknown|unsupported|invalid|unrecognized|unexpected|not support|extra field|additional propert/.test(text)) {
    return true
  }
  return status >= 500 && status < 600 && /upstream gateway error/.test(text)
}

function noteOmit(baseURL: string, model: string, reason: string, state: ThinkingOffState) {
  const key = `${rejectionKey(baseURL, model)}|${reason}`
  if (state.noted.has(key)) return
  state.noted.add(key)
  logTaskWarn('AIConfig', 'thinking-off-skip-reasoning-effort', {
    host: thinkingOffHostKey(baseURL),
    model,
    reason,
  })
}

function responseWithText(response: Response, text: string) {
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function applyGeminiThinkingOff(body: any, input: any) {
  const url = String(typeof input === 'string' ? input : input?.url || '')
  const isGemini3 = /gemini-3/i.test(url) || /gemini-3/i.test(String(body?.model || ''))
  body.generationConfig = {
    ...(body.generationConfig || {}),
    thinkingConfig: isGemini3
      ? { thinkingLevel: 'low' }
      : { thinkingBudget: 0, includeThoughts: false },
  }
}

function chatModelOf(body: any) {
  return typeof body?.model === 'string' ? body.model : ''
}

export function installThinkingOffFetch(options: {
  providerName: string
  baseURL: string
  enabled: boolean
  patchRaw?: string | null
  fetchImpl?: typeof fetch
  state?: ThinkingOffState
}): typeof fetch | undefined {
  if (!options.enabled || isOfficialTextHost(options.baseURL)) return undefined
  const basePatch = parseThinkingOffPatch(options.patchRaw)
  const fetchImpl = options.fetchImpl || fetch
  const state = options.state || sharedState
  const baseURL = options.baseURL

  return async (input: any, init?: any) => {
    let sentReasoningEffortNone = false
    let model = ''
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (options.providerName === 'gemini' && Array.isArray(body?.contents)) {
          applyGeminiThinkingOff(body, input)
          init = { ...init, body: JSON.stringify(body) }
        } else if (Array.isArray(body?.messages)) {
          model = chatModelOf(body)
          const omit = shouldOmitReasoningEffortNone(baseURL, model, state)
          const patch = { ...basePatch }
          if (omit && patch.reasoning_effort === 'none') {
            delete patch.reasoning_effort
            let reason = 'upstream-rejected'
            if (isCodeccHost(baseURL)) reason = 'codecc'
            else if (modelRejectsReasoningEffortNone(model)) reason = 'grok'
            noteOmit(baseURL, model, reason, state)
          }
          Object.assign(body, patch)
          if (omit && body.reasoning_effort === 'none') delete body.reasoning_effort
          sentReasoningEffortNone = body.reasoning_effort === 'none'
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }

    const response = await fetchImpl(input, init)
    if (!sentReasoningEffortNone || response.ok || !init?.body || typeof init.body !== 'string') return response

    const errorText = await response.text()
    if (!isUnsupportedReasoningEffortError(response.status, errorText)) {
      return responseWithText(response, errorText)
    }

    let retryBody: any
    try {
      retryBody = JSON.parse(init.body)
    } catch {
      return responseWithText(response, errorText)
    }
    if (retryBody?.reasoning_effort !== 'none') return responseWithText(response, errorText)
    delete retryBody.reasoning_effort
    const retry = await fetchImpl(input, { ...init, body: JSON.stringify(retryBody) })
    // 只有去掉该字段后上游真正接受,才记住。暂时的 500 不会把关思考字段永久拿掉。
    if (retry.ok) {
      state.rejected.add(rejectionKey(baseURL, model))
      noteOmit(baseURL, model, 'upstream-rejected', state)
    }
    return retry
  }
}
