import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novaris-'))
process.env.SQLITE_PATH = path.join(root, 'novaris.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { bootstrapGrsaiConfigs } = await import('../src/services/grsai-config.ts')
const {
  NOVARIS_IMAGE_PRIORITY,
  bootstrapNovarisConfigs,
  novarisImageModels,
  readNovarisEnv,
} = await import('../src/services/novaris-config.ts')
const { getActiveConfig } = await import('../src/services/ai.ts')
const { joinProviderUrl } = await import('../src/services/adapters/url.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ENV_KEYS = [
  'NOVARIS_API_KEY',
  'NOVARIS_BASE_URL',
  'NOVARIS_IMAGE_MODEL',
  'GRSAI_API_KEY',
  'GRSAI_BASE_URL',
  'GRSAI_IMAGE_MODEL',
  'GRSAI_TEXT_MODEL',
  'GRSAI_VIDEO_MODEL',
] as const

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

const named = (name: string) => db.select().from(schema.aiServiceConfigs)
  .where(eq(schema.aiServiceConfigs.name, name))

test('missing key skips bootstrap and leaves an existing row untouched', async () => {
  setEnv({ NOVARIS_API_KEY: 'seed-key' })
  await bootstrapNovarisConfigs()
  setEnv()
  assert.equal(readNovarisEnv(), null)
  assert.deepEqual(await bootstrapNovarisConfigs(), { configured: false })
  const row = (await named('novaris-image'))[0]
  assert.equal(row.apiKey, 'seed-key')
})

test('novaris image uses its own key and outranks grsai', async () => {
  assert.equal(novarisImageModels()[0], 'gpt-image-2')
  assert.equal(novarisImageModels('  gpt-image-2.6-flare ').filter(model => model === 'gpt-image-2.6-flare').length, 1)
  assert.equal(novarisImageModels('gpt-image-2.6-flare')[0], 'gpt-image-2.6-flare')
  setEnv({
    NOVARIS_API_KEY: 'novaris-test-key',
    NOVARIS_BASE_URL: 'https://api.novaris.com.cn///',
    GRSAI_API_KEY: 'grsai-test-key',
    GRSAI_IMAGE_MODEL: 'gpt-image-2.5',
  })
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    await bootstrapGrsaiConfigs()
    await bootstrapNovarisConfigs()
  } finally {
    console.log = originalLog
  }
  assert.equal(logs.some(line => line.includes('novaris-test-key') || line.includes('grsai-test-key')), false)
  assert.match(logs.join('\n'), /\[novaris\] 已写入图片配置（https:\/\/api\.novaris\.com\.cn）/)

  const image = (await named('novaris-image'))[0]
  assert.equal(image.serviceType, 'image')
  assert.equal(image.provider, 'openai')
  assert.equal(image.baseUrl, 'https://api.novaris.com.cn')
  assert.equal(image.apiKey, 'novaris-test-key')
  assert.equal(image.model, JSON.stringify(novarisImageModels()))
  assert.equal(image.priority, NOVARIS_IMAGE_PRIORITY)
  assert.equal(image.isDefault, false)
  assert.equal(image.isActive, true)
  assert.equal(
    joinProviderUrl(image.baseUrl, '/v1', '/images/generations'),
    'https://api.novaris.com.cn/v1/images/generations',
  )
  const active = await getActiveConfig('image')
  assert.equal(active?.id, image.id)
  assert.equal(active?.model, 'gpt-image-2')
  assert.notEqual(active?.apiKey, 'grsai-test-key')
})
