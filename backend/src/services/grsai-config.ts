/**
 * 从环境变量写入 grsai（OpenAI 兼容）图片配置，文本/视频按需写入。
 * 只在 GRSAI_API_KEY 存在时生效；密钥留在本地 .env，不写入仓库。
 * 图片优先级高于 codecc，两边同时启用时生图走 grsai。
 * 文本/视频不设 isDefault，优先级也低于 codecc，避免抢走文本和视频通道。
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

/** codecc 启动配置使用 100。图片必须高于它，getActiveConfig 才选 grsai。 */
export const GRSAI_IMAGE_PRIORITY = 120
/** 低于 codecc。可选文本/视频保持启用，但不会成为当前通道。 */
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
  }> = [
    { serviceType: 'image', name: CONFIG_NAMES.image, model: env.imageModel, priority: GRSAI_IMAGE_PRIORITY },
  ]
  if (env.textModel) {
    specs.push({ serviceType: 'text', name: CONFIG_NAMES.text, model: env.textModel, priority: GRSAI_OPTIONAL_PRIORITY })
  }
  if (env.videoModel) {
    specs.push({ serviceType: 'video', name: CONFIG_NAMES.video, model: env.videoModel, priority: GRSAI_OPTIONAL_PRIORITY })
  }
  for (const spec of specs) {
    const [existing] = await db.select().from(schema.aiServiceConfigs)
      .where(eq(schema.aiServiceConfigs.name, spec.name))
    const values = {
      serviceType: spec.serviceType,
      provider: 'openai',
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
