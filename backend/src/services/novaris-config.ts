/**
 * 从环境变量写入 Novaris 图片配置。
 * 只在 NOVARIS_API_KEY 存在时生效；密钥留在本地 .env，不写入仓库。
 * 接口是 OpenAI 兼容的 /v1/images，provider 用 openai。
 * 优先级高于 grsai 图片，新的图片请求走这条渠道。已锁定图片配置的旧集不受影响。
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'

const CONFIG_NAME = 'novaris-image'
const DEFAULT_BASE_URL = 'https://api.novaris.com.cn'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2'

/** 账号模型列表。首选模型放在第 0 位，设置页点选后仍可换。 */
export const NOVARIS_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst-c',
  'gpt-image-2.5-flare-c',
] as const

/** grsai 图片是 120。高于它，getActiveConfig 才选 Novaris。 */
export const NOVARIS_IMAGE_PRIORITY = 130

export function novarisImageModels(preferredRaw?: string) {
  const preferred = (preferredRaw ?? '').trim() || DEFAULT_IMAGE_MODEL
  return [preferred, ...NOVARIS_IMAGE_MODELS.filter(model => model !== preferred)]
}

export function readNovarisEnv() {
  const apiKey = (process.env.NOVARIS_API_KEY || '').trim()
  if (!apiKey) return null
  const baseUrl = (process.env.NOVARIS_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  return {
    apiKey,
    baseUrl: baseUrl || DEFAULT_BASE_URL,
    models: novarisImageModels(process.env.NOVARIS_IMAGE_MODEL),
  }
}

export async function bootstrapNovarisConfigs() {
  const env = readNovarisEnv()
  if (!env) return { configured: false as const }
  const ts = now()
  const values = {
    serviceType: 'image' as const,
    provider: 'openai',
    name: CONFIG_NAME,
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: JSON.stringify(env.models),
    priority: NOVARIS_IMAGE_PRIORITY,
    isDefault: false,
    isActive: true,
    updatedAt: ts,
  }
  const [existing] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.name, CONFIG_NAME))
  if (existing) {
    await db.update(schema.aiServiceConfigs).set(values).where(eq(schema.aiServiceConfigs.id, existing.id))
  } else {
    await db.insert(schema.aiServiceConfigs).values({ ...values, createdAt: ts })
  }
  console.log(`[novaris] 已写入图片配置（${env.baseUrl}）`)
  return { configured: true as const }
}
