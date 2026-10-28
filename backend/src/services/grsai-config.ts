/**
 * 从环境变量写入 grsai 配置。
 * 只在 GRSAI_API_KEY 存在时生效；密钥留在本地 .env，不写入仓库。
 * 图片走 OpenAI 兼容接口，优先级高于 codecc。
 * 视频在 GRSAI_VIDEO_MODEL 有值时写入 provider=grsai（MiniMax H3 中转），
 * 优先级同样高于 codecc，启动后成为当前视频通道。模型名清空则停用该行。
 * 文本仅在模型名非空时写入，优先级低于 codecc，且不设 isDefault。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'

const CONFIG_NAMES = {
  text: 'grsai-text',
  image: 'grsai-image',
  video: 'grsai-video',
} as const

const DEFAULT_BASE_URL = 'https://grsaiapi.com'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5'

/** codecc 启动配置使用 100。图片和视频必须高于它，getActiveConfig 才选 grsai。 */
export const GRSAI_IMAGE_PRIORITY = 120
export const GRSAI_VIDEO_PRIORITY = 120
/** 低于 codecc。可选文本保持启用，但不会成为当前文本通道。 */
export const GRSAI_OPTIONAL_PRIORITY = 90

export function readGrsaiEnv() {
  const apiKey = (process.env.GRSAI_API_KEY || '').trim()
  if (!apiKey) return null
  const baseUrl = (process.env.GRSAI_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  return {
    apiKey,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    imageModel: (process.env.GRSAI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim() || DEFAULT_IMAGE_MODEL,
    textModel: (process.env.GRSAI_TEXT_MODEL || '').trim(),
    videoModel: (process.env.GRSAI_VIDEO_MODEL || '').trim(),
  }
}

export async function bootstrapGrsaiConfigs() {
  const env = readGrsaiEnv()
  if (!env) return { configured: false as const }
  const ts = now()
  const specs: Array<{
    serviceType: 'text' | 'image' | 'video'
    name: string
    model: string
    priority: number
    provider: 'openai' | 'grsai'
  }> = [
    { serviceType: 'image', name: CONFIG_NAMES.image, model: env.imageModel, priority: GRSAI_IMAGE_PRIORITY, provider: 'openai' },
  ]
  if (env.textModel) {
    specs.push({ serviceType: 'text', name: CONFIG_NAMES.text, model: env.textModel, priority: GRSAI_OPTIONAL_PRIORITY, provider: 'openai' })
  }
  if (env.videoModel) {
    specs.push({ serviceType: 'video', name: CONFIG_NAMES.video, model: env.videoModel, priority: GRSAI_VIDEO_PRIORITY, provider: 'grsai' })
  } else {
    // 模型名清空后不再占据视频通道。行保留，下次写回模型时再启用。
    await db.update(schema.aiServiceConfigs)
      .set({ isActive: false, updatedAt: ts })
      .where(eq(schema.aiServiceConfigs.name, CONFIG_NAMES.video))
  }
  for (const spec of specs) {
    const [existing] = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.name, spec.name))
    const values = {
      serviceType: spec.serviceType,
      provider: spec.provider,
      name: spec.name,
      baseUrl: env.baseUrl,
      apiKey: env.apiKey,
      model: JSON.stringify([spec.model]),
      priority: spec.priority,
      isDefault: false,
      isActive: true,
      updatedAt: ts,
    }
    if (existing) {
      await db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id))
    } else {
      await db.insert(schema.aiServiceConfigs).values({ ...values, createdAt: ts })
    }
  }
  const labels = specs.map(spec => ({ image: '图片', text: '文本', video: '视频' }[spec.serviceType])).join('/')
  console.log(`[grsai] 已写入${labels}配置（${env.baseUrl}）`)
  return { configured: true as const }
}
