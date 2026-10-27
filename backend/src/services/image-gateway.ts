import { PLAY_STILL_FRAME } from './rpg/references.js'

/** 图片网关瞬时失败。视频提交不走这里，避免一次 502 被当成可以安全重放。 */
export const IMAGE_GATEWAY_ATTEMPTS = 3
export const IMAGE_GATEWAY_RETRY_MS = 1500
export const EDITS_FALLBACK_MESSAGE = '参考图编辑接口失败，已改为纯文生图，本次剧情图不含参考图'
export const GROK_REFERENCE_HTTPS_MESSAGE = '参考图没有可拉取的 https 地址，已改为纯文生图'
export const OFFICIAL_XAI_IMAGE_BASE = 'https://api.x.ai'
export const EDITS_FALLBACK_PROMPT_NOTE = '参考图未能提交给图片编辑接口。不要依赖参考图。人物的脸、发型、服装和场景空间必须严格按上文已经写明的外貌与场景描述来画，保持同一张脸、同一套衣服、同一个地点。'

export function isRetryableImageGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** 剧情图的 edits 在重试耗尽后仍是网关 5xx 时，改走不带参考图的 generations。定妆图不走这条。直连 xAI 若鉴权失败也回退。 */
export function shouldFallbackFromImageEdits(
  status: number,
  frameType: unknown,
  hadReferences: boolean,
  officialAuthFailed = false,
): boolean {
  if (!hadReferences || frameType !== PLAY_STILL_FRAME) return false
  if (isRetryableImageGatewayStatus(status)) return true
  return officialAuthFailed && (status === 401 || status === 403)
}

export function isOfficialXaiBase(baseUrl: string | null | undefined): boolean {
  try {
    return new URL(baseUrl || '').hostname.toLowerCase() === 'api.x.ai'
  } catch {
    return false
  }
}

export function isXaiApiKey(apiKey: string | null | undefined): boolean {
  return (apiKey || '').trim().startsWith('xai-')
}

/**
 * 只有手头已经是 xAI 凭据时，才把 Grok edits 改打到 api.x.ai。
 * 显式 XAI_API_KEY、另一条 base 为 api.x.ai 的图片配置，或当前密钥以 xai- 开头。
 * 中转站密钥不会被拿去猜官方接口。当前配置本来就是 api.x.ai 时不必改写。
 */
export function officialXaiEditsTarget(input: {
  baseUrl: string
  apiKey: string
  explicitApiKey?: string | null
  explicitBaseUrl?: string | null
  storedOfficial?: { baseUrl: string; apiKey: string } | null
}): { baseUrl: string; apiKey: string } | null {
  if (isOfficialXaiBase(input.baseUrl)) return null
  const explicit = (input.explicitApiKey || '').trim()
  if (explicit) {
    const base = (input.explicitBaseUrl || OFFICIAL_XAI_IMAGE_BASE).trim().replace(/\/+$/, '')
    return isOfficialXaiBase(base) ? { baseUrl: base, apiKey: explicit } : null
  }
  const stored = input.storedOfficial
  if (stored && stored.apiKey.trim() && isOfficialXaiBase(stored.baseUrl)) {
    return { baseUrl: stored.baseUrl.trim().replace(/\/+$/, ''), apiKey: stored.apiKey.trim() }
  }
  if (isXaiApiKey(input.apiKey)) {
    return { baseUrl: OFFICIAL_XAI_IMAGE_BASE, apiKey: input.apiKey.trim() }
  }
  return null
}

export function promptAfterEditsFallback(prompt: string | null | undefined): string {
  const text = (prompt || '').trim()
  if (text.includes('参考图未能提交给图片编辑接口')) return text
  return text ? `${text}\n${EDITS_FALLBACK_PROMPT_NOTE}` : EDITS_FALLBACK_PROMPT_NOTE
}

export function imageGatewayError(status: number): string {
  return `图片服务暂时不可用（HTTP ${status}），请稍后再试`
}

/**
 * Grok JSON edits 的 image.url 只放可拉取的 https。
 * 优先用已经是 https 的地址，其次用定妆任务上的供应商 CDN（result_url），
 * 再次用 PUBLIC_BASE_URL 上的压缩文件。data URL 不放上这条链路。
 */
export function selectGrokReferenceUrl(input: {
  reference: string
  providerResultUrl?: string | null
  publicFileUrl?: string | null
}): string | null {
  const reference = input.reference.trim()
  if (reference.startsWith('https://')) return reference
  const provider = (input.providerResultUrl || '').trim()
  if (provider.startsWith('https://')) return provider
  const published = (input.publicFileUrl || '').trim()
  if (published.startsWith('https://')) return published
  return null
}
