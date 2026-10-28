/**
 * OpenAI 兼容图片适配器。
 * 文生图: POST /v1/images/generations（JSON）。
 * GPT Image 参考图: POST /v1/images/edits，multipart 里重复字段名 image（不是 image[]）。
   * codecc 上的 Grok Imagine 不接受 multipart，edits 必须是 JSON：
 *   一张参考图用 image，多张用 images（codecc 上最多 2 张），url 必须是 https，并带 response_format。
 * 响应: { data: [{ url }] } 或 { data: [{ b64_json }] }。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { parseDataUrl } from '../../utils/storage.js'

/** codecc 上 grok-imagine-image-quality 的 edits：1～2 张 https 参考图返回 200，4 张返回 502。 */
export const GROK_IMAGE_REFERENCE_LIMIT = 2

export class OpenAIImageAdapter implements ImageProviderAdapter {
  provider = 'openai'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'gpt-image-2'
    const isGptImage = model.startsWith('gpt-image-')
    const isGptImage2 = model === 'gpt-image-2'
    const size = isGptImage2
      ? this.normalizeGptImage2Size(record.size)
      : isGptImage
      ? this.normalizeGptImageSize(record.size)
      : record.size || '1024x1024'

    // 有参考图 → edits；无参考图 → 纯文生图 generations。Grok 的 edits 是 JSON，不是 multipart。
    const refs = this.parseReferenceImages(record.referenceImages)
    if (refs.length) {
      if (this.isGrokImage(model)) return this.buildGrokEditsRequest(config, model, record.prompt, size, refs)
      return this.buildEditsRequest(config, model, record.prompt, size, refs, isGptImage)
    }

    const body: any = {
      model,
      prompt: record.prompt,
      size,
      n: 1,
    }

    if (!isGptImage) {
      body.response_format = 'url'
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private parseReferenceImages(raw?: string | null): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }

  private isGrokImage(model: string) {
    return /grok|imagine/i.test(model)
  }

  /**
   * xAI / codecc：application/json。一张图用 image，两张及以上用 images。
   * url 必须是供应商能 GET 的 https。data URL 会让这条网关 502。
   */
  private buildGrokEditsRequest(
    config: AIConfig,
    model: string,
    prompt: string | null | undefined,
    size: string,
    refs: string[],
  ): ProviderRequest {
    const images: Array<{ type: 'image_url'; url: string }> = []
    for (const ref of refs) {
      const url = ref.trim()
      if (!url.startsWith('https://')) continue
      images.push({ type: 'image_url', url })
      if (images.length >= GROK_IMAGE_REFERENCE_LIMIT) break
    }
    if (!images.length) {
      throw new Error('参考图片无法交给 Grok 编辑（需要可拉取的 https 地址）')
    }

    const body: Record<string, unknown> = {
      model,
      prompt: prompt || '',
      response_format: 'url',
    }
    const aspectRatio = this.grokAspectRatio(size)
    if (aspectRatio) body.aspect_ratio = aspectRatio
    if (images.length === 1) body.image = images[0]
    else body.images = images

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/edits'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  /** 1920x1080 这类尺寸映射到 Grok 接受的比例，让剧情图保持横版。 */
  private grokAspectRatio(size?: string | null): string | undefined {
    const allowed = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']
    const normalized = (size || '').trim().toLowerCase()
    if (allowed.includes(normalized)) return normalized
    const [width, height] = normalized.split('x').map(Number)
    if (!width || !height) return undefined
    const ratio = width / height
    let best = allowed[0]
    let bestDiff = Number.POSITIVE_INFINITY
    for (const item of allowed) {
      const [w, h] = item.split(':').map(Number)
      const diff = Math.abs(ratio - w / h)
      if (diff < bestDiff) {
        best = item
        bestDiff = diff
      }
    }
    return best
  }

  /**
   * OpenAI /v1/images/edits：同一字段名 image 重复上传。
   * dall-e-2 只收一张；GPT Image 可收多张，且不能带 response_format。
   * multipart 边界由 fetch 自动设置，不要手填 Content-Type。
   */
  private buildEditsRequest(
    config: AIConfig,
    model: string,
    prompt: string | null | undefined,
    size: string,
    refs: string[],
    isGptImage: boolean,
  ): ProviderRequest {
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt || '')
    form.append('size', size)
    form.append('n', '1')
    if (!isGptImage) form.append('response_format', 'url')

    let appended = 0
    const sources = isGptImage ? refs : refs.slice(0, 1)
    for (const ref of sources) {
      const parsed = parseDataUrl(ref)
      if (!parsed) continue
      const buffer = Buffer.from(parsed.data, 'base64')
      const ext = parsed.mimeType === 'image/png' ? 'png' : parsed.mimeType === 'image/webp' ? 'webp' : 'jpg'
      form.append('image', new Blob([buffer], { type: parsed.mimeType }), `reference-${++appended}.${ext}`)
    }
    if (!appended) {
      throw new Error('参考图片无法解析为可上传的文件（仅支持 data URL 形式的图片）')
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/edits'),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: form,
    }
  }

  private normalizeGptImageSize(size?: string | null): string {
    const allowed = ['1024x1024', '1536x1024', '1024x1536', 'auto']
    if (!size) return '1024x1024'

    const normalized = size.toLowerCase()
    if (allowed.includes(normalized)) return normalized

    const [width, height] = normalized.split('x').map(Number)
    if (!width || !height) return 'auto'
    if (width === height) return '1024x1024'
    return width > height ? '1536x1024' : '1024x1536'
  }

  private normalizeGptImage2Size(size?: string | null): string {
    if (!size) return '1024x1024'
    const normalized = size.toLowerCase()
    if (normalized === 'auto') return 'auto'

    const [rawWidth, rawHeight] = normalized.split('x').map(Number)
    if (!rawWidth || !rawHeight) return 'auto'

    const width = this.roundToMultiple(Math.min(4096, Math.max(256, rawWidth)), 16)
    const height = this.roundToMultiple(Math.min(4096, Math.max(256, rawHeight)), 16)
    return `${width}x${height}`
  }

  private roundToMultiple(value: number, multiple: number): number {
    return Math.max(multiple, Math.round(value / multiple) * multiple)
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // OpenAI DALL-E 3 目前是同步返回，但规范上也有异步 task 模式
    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    // b64_json 模式
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      // 对于 base64，返回特殊标记，实际处理在 extractImageBase64
      return { isAsync: false, imageUrl: undefined }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'completed') {
      return {
        status: 'completed',
        imageUrl: result.image_url || result.data?.[0]?.url || null,
      }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error?.message || 'Generation failed' }
    }
    return { status: result.status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }
    return null
  }
}
