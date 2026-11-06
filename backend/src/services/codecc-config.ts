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
  gptText: 'codecc-gpt-text',
} as const

const DEFAULT_TEXT_MODEL = 'grok-4.7'
const DEFAULT_BASE_URL = 'https://codecc.cc'
/** gpt-6.1 与 grok 不是同一把密钥，单独落在 codecc-gpt-text。 */
export const CODECC_GPT_TEXT_MODELS = ['gpt-6.1-sol', 'gpt-6.1-terra']
/** 低于 codecc-text 的 100，高于 grsai 可选文本的 90。启动后不抢当前文本通道。 */
export const CODECC_GPT_TEXT_PRIORITY = 95

export function codeccTextModels(preferredRaw?: string) {
  const preferred = (preferredRaw ?? '').trim() || DEFAULT_TEXT_MODEL
  return [preferred]
}

export function readCodeccEnv() {
  const apiKey = (process.env.CODECC_API_KEY || '').trim()
  if (!apiKey) return null
  return {
    apiKey,
    baseUrl: (process.env.CODECC_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    textModels: codeccTextModels(process.env.CODECC_TEXT_MODEL),
    imageModel: (process.env.CODECC_IMAGE_MODEL || 'grok-imagine-image-quality').trim(),
    videoModel: (process.env.CODECC_VIDEO_MODEL || 'grok-imagine-video-1.5').trim(),
  }
}

export function readCodeccGptEnv() {
  const apiKey = (process.env.CODECC_GPT_API_KEY || '').trim()
  if (!apiKey) return null
  const baseUrl = (process.env.CODECC_GPT_BASE_URL || process.env.CODECC_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, '')
  return {
    apiKey,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    models: [...CODECC_GPT_TEXT_MODELS],
  }
}

export async function bootstrapCodeccConfigs() {
  const env = readCodeccEnv()
  if (!env) return bootstrapCodeccGptText()
  const ts = now()
  const specs = [
    { serviceType: 'text' as const, name: CONFIG_NAMES.text, models: env.textModels },
    { serviceType: 'image' as const, name: CONFIG_NAMES.image, models: [env.imageModel] },
    { serviceType: 'video' as const, name: CONFIG_NAMES.video, models: [env.videoModel] },
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
      model: JSON.stringify(spec.models),
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
  await bootstrapCodeccGptText()
  return { configured: true as const }
}

/** gpt-6.1-sol / gpt-6.1-terra。没配 CODECC_GPT_API_KEY 时不改已有行。 */
export async function bootstrapCodeccGptText() {
  const env = readCodeccGptEnv()
  if (!env) return { configured: false as const }
  const ts = now()
  const values = {
    serviceType: 'text' as const,
    provider: 'openai',
    name: CONFIG_NAMES.gptText,
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: JSON.stringify(env.models),
    priority: CODECC_GPT_TEXT_PRIORITY,
    isDefault: false,
    isActive: true,
    updatedAt: ts,
  }
  const [existing] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.name, CONFIG_NAMES.gptText))
  if (existing) {
    await db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id))
  } else {
    await db.insert(schema.aiServiceConfigs).values({ ...values, createdAt: ts })
  }
  console.log(`[codecc] 已写入 GPT 文本配置（${env.baseUrl}）`)
  return { configured: true as const }
}
