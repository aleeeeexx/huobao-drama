/**
 * 从环境变量写入 codecc（OpenAI 兼容）文本 / 图片 / 视频配置。
 * 只在 CODECC_API_KEY 存在时生效；密钥留在本地 .env，不写入仓库。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'

const CONFIG_NAMES = {
  text: 'codecc-text',
  image: 'codecc-image',
  video: 'codecc-video',
} as const

export function readCodeccEnv() {
  const apiKey = (process.env.CODECC_API_KEY || '').trim()
  if (!apiKey) return null
  return {
    apiKey,
    baseUrl: (process.env.CODECC_BASE_URL || 'https://codecc.cc').trim().replace(/\/+$/, ''),
    textModel: (process.env.CODECC_TEXT_MODEL || 'grok-4.7').trim(),
    imageModel: (process.env.CODECC_IMAGE_MODEL || 'grok-imagine-image-quality').trim(),
    videoModel: (process.env.CODECC_VIDEO_MODEL || 'grok-imagine-video-1.5').trim(),
  }
}

export async function bootstrapCodeccConfigs() {
  const env = readCodeccEnv()
  if (!env) return { configured: false as const }
  const ts = now()
  const specs = [
    { serviceType: 'text' as const, name: CONFIG_NAMES.text, model: env.textModel },
    { serviceType: 'image' as const, name: CONFIG_NAMES.image, model: env.imageModel },
    { serviceType: 'video' as const, name: CONFIG_NAMES.video, model: env.videoModel },
  ]
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
      priority: 100,
      isDefault: true,
      isActive: true,
      updatedAt: ts,
    }
    if (existing) {
      await db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id))
    } else {
      await db.insert(schema.aiServiceConfigs).values({ ...values, createdAt: ts })
    }
  }
  console.log(`[codecc] 已写入文本/图片/视频配置（${env.baseUrl}）`)
  return { configured: true as const }
}
