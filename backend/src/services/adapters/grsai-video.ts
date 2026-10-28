/**
 * grsai MiniMax H3 视频中转 Adapter。
 * 提交: POST {base}/v1/api/generate
 * 轮询: GET  {base}/v1/api/result?id={taskId}
 *
 * 与官方 MiniMax `/v2/video_generation`、OpenAI `/v1/videos` 都不是同一套协议。
 * generation.createTask 把 config.provider 写进 sys_task.provider，轮询和恢复都按这个值选适配器，
 * 所以配置行的 provider 必须是 grsai，不能写成 openai。
 *
 * 文档: https://qmy27nhsd9.apifox.cn/514679297e0
 * 轮询: https://qmy27nhsd9.apifox.cn/452409577e0
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

const DEFAULT_MODEL = 'minimax-h3'
const REPLY_TYPE_ASYNC = 'async'
const IMAGE_LIMIT = 9
const AUDIO_LIMIT = 3
const DURATION_MIN = 1
const DURATION_MAX = 15
const DURATION_MAX_1080P = 10
const DEFAULT_DURATION = 5
const DEFAULT_RESOLUTION = '768p'

const RESOLUTIONS = {
  '480p': '480p',
  '768p': '768p',
  '1080p': '1080p',
} as const

type GrsaiResolution = (typeof RESOLUTIONS)[keyof typeof RESOLUTIONS]
type GrsaiAspectRatio = 'portrait' | 'landscape'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((url): url is string => typeof url === 'string')
      .map(url => url.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function pushUnique(target: string[], value?: string | null) {
  const url = (value || '').trim()
  if (!url || target.includes(url)) return
  target.push(url)
}

function failureMessage(result: any): string {
  const err = result?.error
  const detail = typeof err === 'string'
    ? err.trim()
    : (err && typeof err === 'object' ? String(err.message || err.msg || '').trim() : '')
  if (String(result?.status || '').toLowerCase() === 'violation') {
    return detail ? `内容审核未通过：${detail}` : '内容审核未通过'
  }
  return detail || '视频生成失败'
}

export class GrsaiVideoAdapter implements VideoProviderAdapter {
  provider = 'grsai'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = (record.model || config.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL
    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('grsai 视频生成需要提示词')

    const images = this.collectImages(record)
    const audios = parseUrlArray(record.referenceAudioUrls)
    if (images.length > IMAGE_LIMIT) {
      throw new Error(`参考图片超限：grsai 最多 ${IMAGE_LIMIT} 张，当前 ${images.length}`)
    }
    if (audios.length > AUDIO_LIMIT) {
      throw new Error(`参考音频超限：grsai 最多 ${AUDIO_LIMIT} 条，当前 ${audios.length}`)
    }

    const resolution = this.normalizeResolution(record.resolution)
    const body: Record<string, unknown> = {
      model,
      prompt,
      aspectRatio: this.normalizeAspectRatio(record.aspectRatio),
      resolution,
      duration: this.normalizeDuration(record.duration, resolution),
      replyType: REPLY_TYPE_ASYNC,
      promptSkill: this.normalizePromptSkill(record.promptExtend),
    }
    if (images.length) body.images = images
    if (audios.length) body.audios = audios
    const seed = this.normalizeSeed(record.seed)
    if (seed !== undefined) body.seed = seed

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/api/generate'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const status = String(result?.status || '').toLowerCase()
    const taskId = result?.id ?? result?.task_id
    if (status === 'failed' || status === 'violation') {
      throw new Error(failureMessage(result))
    }
    const videoUrl = this.extractVideoUrl(result)
    const id = taskId == null || taskId === '' ? undefined : String(taskId)
    if (videoUrl) return { isAsync: false, videoUrl, taskId: id }
    if (id) return { isAsync: true, taskId: id }
    throw new Error('grsai 没有返回任务 id')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const endpoint = joinProviderUrl(config.baseUrl, '/v1', '/api/result')
    const url = new URL(endpoint)
    url.searchParams.set('id', taskId)
    return {
      url: url.toString(),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '').toLowerCase()
    if (status === 'succeeded') {
      const videoUrl = this.extractVideoUrl(result)
      if (!videoUrl) return { status: 'processing' }
      return { status: 'completed', videoUrl }
    }
    if (status === 'failed' || status === 'violation') {
      return { status: 'failed', error: failureMessage(result) }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const results = result?.results
    if (!Array.isArray(results)) return null
    for (const item of results) {
      const url = typeof item?.url === 'string' ? item.url.trim() : ''
      if (url) return url
    }
    return null
  }

  private collectImages(record: VideoGenerationRecord): string[] {
    const images: string[] = []
    pushUnique(images, record.firstFrameUrl || record.imageUrl)
    pushUnique(images, record.lastFrameUrl)
    for (const url of parseUrlArray(record.referenceImageUrls)) pushUnique(images, url)
    return images
  }

  /** 16:9 → landscape，9:16 → portrait；1:1 / adaptive / 空值等不明确时用 landscape。 */
  private normalizeAspectRatio(ratio?: string | null): GrsaiAspectRatio {
    const value = (ratio || '').trim().toLowerCase()
    if (value === 'portrait' || value === '9:16' || value === '3:4') return 'portrait'
    return 'landscape'
  }

  /** 项目内 720p 对应 grsai 的 768p；2K 归到 1080p；无法识别时用 768p。 */
  private normalizeResolution(resolution?: string | null): GrsaiResolution {
    const value = (resolution || '').trim().toLowerCase()
    if (value === '480p' || value === '480') return RESOLUTIONS['480p']
    if (value === '1080p' || value === '1080' || value === '2k') return RESOLUTIONS['1080p']
    if (value === '768p' || value === '768' || value === '720p' || value === '720') return RESOLUTIONS['768p']
    return DEFAULT_RESOLUTION
  }

  /** 缺省 5 秒；显式数值收成 1–15 的整数，1080p 最长 10 秒。 */
  private normalizeDuration(duration: number | null | undefined, resolution: GrsaiResolution): number {
    const parsed = duration === null || duration === undefined ? Number.NaN : Math.round(Number(duration))
    const value = Number.isFinite(parsed) ? parsed : DEFAULT_DURATION
    const max = resolution === '1080p' ? DURATION_MAX_1080P : DURATION_MAX
    return Math.min(max, Math.max(DURATION_MIN, value))
  }

  /** 未设置时跟 API 默认一样打开 promptSkill；制作台关掉提示词扩展时才关闭。 */
  private normalizePromptSkill(promptExtend: number | boolean | null | undefined): boolean {
    return promptExtend !== false && promptExtend !== 0
  }

  private normalizeSeed(seed: number | null | undefined): number | undefined {
    if (seed === null || seed === undefined) return undefined
    const value = Number(seed)
    if (!Number.isFinite(value)) return undefined
    return Math.trunc(value)
  }
}
