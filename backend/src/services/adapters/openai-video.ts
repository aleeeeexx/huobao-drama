/**
 * OpenAI 兼容视频适配器。
 * codecc 上的 Grok Imagine 走 xAI 协议：
 *   POST /v1/videos/generations -> { request_id }
 *   GET  /v1/videos/{request_id} -> { status: pending|done|failed, video: { url } }
 * 其他模型走 OpenAI Sora 式 POST /v1/videos。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const DEFAULT_MODEL = 'grok-imagine-video-1.5'
const DATA_URL_LIMIT = 1_500_000

function isGrokVideo(model: string) {
  return /grok|imagine/i.test(model)
}

export class OpenAIVideoAdapter implements VideoProviderAdapter {
  provider = 'openai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('视频生成需要提示词')
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    }
    if (isGrokVideo(model)) {
      const body: Record<string, unknown> = {
        model,
        prompt,
        duration: this.normalizeDuration(record.duration),
        aspect_ratio: this.normalizeRatio(record.aspectRatio),
        resolution: this.normalizeResolution(record.resolution),
      }
      const image = this.referenceImage(record)
      if (image) body.image = { url: image }
      return {
        url: joinProviderUrl(config.baseUrl, '/v1', '/videos/generations'),
        method: 'POST',
        headers,
        body,
      }
    }
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/videos'),
      method: 'POST',
      headers,
      body: {
        model,
        prompt,
        seconds: String(this.normalizeDuration(record.duration)),
        size: '1280x720',
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result?.request_id ?? result?.id ?? result?.task_id
    const videoUrl = result?.video?.url || result?.url || result?.video_url
    const status = String(result?.status || '')
    if (videoUrl && (!status || status === 'done' || status === 'completed' || status === 'succeeded')) {
      return { isAsync: false, videoUrl, taskId: taskId == null ? undefined : String(taskId), duration: result?.video?.duration }
    }
    if (taskId != null) return { isAsync: true, taskId: String(taskId) }
    throw new Error('视频接口没有返回 request_id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/videos/${taskId}`),
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '')
    if (status === 'done' || status === 'completed' || status === 'succeeded') {
      const videoUrl = result?.video?.url || result?.url || result?.video_url || null
      if (!videoUrl) return { status: 'processing' }
      return { status: 'completed', videoUrl, duration: result?.video?.duration ?? result?.duration }
    }
    if (status === 'failed' || status === 'expired' || status === 'cancelled') {
      const err = result?.error
      const message = typeof err === 'string' ? err : (err?.message || '视频生成失败')
      return { status: 'failed', error: message }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result?.video?.url || result?.url || result?.video_url || null
  }

  resolveDownload(config: AIConfig, videoUrl: string): { url: string; headers?: Record<string, string> } {
    const absolute = this.absoluteUrl(config.baseUrl, videoUrl)
    const needsAuth = /\/videos\/[^/]+\/content(?:\?|$)/.test(absolute)
    return needsAuth
      ? { url: absolute, headers: { Authorization: `Bearer ${config.apiKey}` } }
      : { url: absolute }
  }

  private absoluteUrl(baseUrl: string, videoUrl: string) {
    if (/^https?:\/\//i.test(videoUrl)) return videoUrl
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    return new URL(videoUrl, base).toString()
  }

  private normalizeDuration(duration?: number | null): number {
    const value = Number(duration)
    if (!Number.isFinite(value)) return 6
    return Math.min(15, Math.max(1, Math.round(value)))
  }

  private normalizeRatio(ratio?: string | null): string {
    const value = (ratio || '').trim()
    return ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(value) ? value : '16:9'
  }

  private normalizeResolution(resolution?: string | null): string {
    const value = (resolution || '').trim().toLowerCase()
    return value === '480p' ? '480p' : '720p'
  }

  private referenceImage(record: VideoGenerationRecord): string | null {
    const image = (record.firstFrameUrl || record.imageUrl || '').trim()
    if (!image) return null
    if (/^https?:\/\//.test(image)) return image
    if (image.startsWith('data:image/') && image.length <= DATA_URL_LIMIT) return image
    return null
  }
}
