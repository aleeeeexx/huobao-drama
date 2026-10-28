import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-grsai-'))
process.env.SQLITE_PATH = path.join(root, 'grsai.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { bootstrapCodeccConfigs } = await import('../src/services/codecc-config.ts')
const {
  GRSAI_IMAGE_PRIORITY,
  GRSAI_OPTIONAL_PRIORITY,
  bootstrapGrsaiConfigs,
  readGrsaiEnv,
} = await import('../src/services/grsai-config.ts')
const { getActiveConfig } = await import('../src/services/ai.ts')
const { joinProviderUrl } = await import('../src/services/adapters/url.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ENV_KEYS = [
  'GRSAI_API_KEY',
  'GRSAI_BASE_URL',
  'GRSAI_IMAGE_MODEL',
  'GRSAI_TEXT_MODEL',
  'GRSAI_VIDEO_MODEL',
  'CODECC_API_KEY',
  'CODECC_BASE_URL',
  'CODECC_TEXT_MODEL',
  'CODECC_IMAGE_MODEL',
  'CODECC_VIDEO_MODEL',
] as const

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

const named = (name: string) => db.select().from(schema.aiServiceConfigs)
  .where(eq(schema.aiServiceConfigs.name, name))

test('missing key skips bootstrap and leaves an existing row untouched', async () => {
  setEnv()
  assert.equal(readGrsaiEnv(), null)
  assert.deepEqual(await bootstrapGrsaiConfigs(), { configured: false })

  setEnv({ GRSAI_API_KEY: 'grsai-test-key' })
  assert.equal((await bootstrapGrsaiConfigs()).configured, true)
  setEnv({ GRSAI_API_KEY: '   ' })
  assert.equal((await bootstrapGrsaiConfigs()).configured, false)
  assert.equal((await named('grsai-image')).length, 1)
})

test('startup upserts grsai-image above codecc and keeps text on codecc', async () => {
  setEnv({
    CODECC_API_KEY: 'codecc-test-key',
    GRSAI_API_KEY: 'grsai-test-key',
    GRSAI_BASE_URL: 'https://grsaiapi.com///',
    GRSAI_IMAGE_MODEL: '  ',
  })
  const logs: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')) }
  try {
    await bootstrapCodeccConfigs()
    await bootstrapGrsaiConfigs()
  } finally {
    console.log = originalLog
  }

  assert.equal(logs.some(line => line.includes('grsai-test-key')), false)
  assert.match(logs.join('\n'), /\[grsai\] 已写入图片配置（https:\/\/grsaiapi\.com）/)

  const images = await named('grsai-image')
  assert.equal(images.length, 1)
  const image = images[0]
  assert.equal(image.serviceType, 'image')
  assert.equal(image.provider, 'openai')
  assert.equal(image.baseUrl, 'https://grsaiapi.com')
  assert.equal(image.apiKey, 'grsai-test-key')
  assert.equal(image.model, JSON.stringify(['gpt-image-2.5']))
  assert.equal(image.priority, GRSAI_IMAGE_PRIORITY)
  assert.equal(image.priority, 120)
  assert.equal(image.isActive, true)
  assert.equal(image.isDefault, false)
  assert.equal(
    joinProviderUrl(image.baseUrl, '/v1', '/images/generations'),
    'https://grsaiapi.com/v1/images/generations',
  )
  assert.equal((await named('grsai-text')).length, 0)
  assert.equal((await named('grsai-video')).length, 0)

  const activeImage = await getActiveConfig('image')
  assert.equal(activeImage?.id, image.id)
  assert.equal(activeImage?.model, 'gpt-image-2.5')
  const activeText = await getActiveConfig('text')
  assert.equal(activeText?.model, 'grok-4.7')
  assert.notEqual(activeText?.id, image.id)

  const codeccImage = (await named('codecc-image'))[0]
  assert.equal(codeccImage.priority, 100)
  assert.equal(codeccImage.isDefault, true)
  assert.equal(codeccImage.isActive, true)
})

test('repeat startup updates the same row; optional text and video stay below codecc', async () => {
  setEnv({
    CODECC_API_KEY: 'codecc-test-key',
    GRSAI_API_KEY: 'grsai-test-key-2',
    GRSAI_BASE_URL: 'https://example.grsai.test',
    GRSAI_IMAGE_MODEL: 'gpt-image-custom',
    GRSAI_TEXT_MODEL: 'grsai-text-model',
    GRSAI_VIDEO_MODEL: 'grsai-video-model',
  })
  const before = (await named('grsai-image'))[0]
  await bootstrapCodeccConfigs()
  await bootstrapGrsaiConfigs()
  await bootstrapGrsaiConfigs()

  const images = await named('grsai-image')
  assert.equal(images.length, 1)
  assert.equal(images[0].id, before.id)
  assert.equal(images[0].apiKey, 'grsai-test-key-2')
  assert.equal(images[0].baseUrl, 'https://example.grsai.test')
  assert.equal(images[0].model, JSON.stringify(['gpt-image-custom']))
  assert.equal(images[0].isDefault, false)
  assert.equal((await getActiveConfig('image'))?.id, images[0].id)

  const text = (await named('grsai-text'))[0]
  const video = (await named('grsai-video'))[0]
  assert.equal(text.serviceType, 'text')
  assert.equal(text.provider, 'openai')
  assert.equal(text.priority, GRSAI_OPTIONAL_PRIORITY)
  assert.equal(text.priority < 100, true)
  assert.equal(text.isActive, true)
  assert.equal(text.isDefault, false)
  assert.equal(text.model, JSON.stringify(['grsai-text-model']))
  assert.equal(video.serviceType, 'video')
  assert.equal(video.priority, GRSAI_OPTIONAL_PRIORITY)
  assert.equal(video.isDefault, false)
  assert.equal(video.isActive, true)
  assert.equal((await named('grsai-text')).length, 1)
  assert.equal((await named('grsai-video')).length, 1)

  assert.equal((await getActiveConfig('text'))?.model, 'grok-4.7')
  assert.equal((await getActiveConfig('video'))?.model, 'grok-imagine-video-1.5')

  setEnv({ GRSAI_API_KEY: 'only-grsai', GRSAI_TEXT_MODEL: 'solo-text' })
  await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.name, 'codecc-text'))
  await bootstrapGrsaiConfigs()
  assert.equal((await getActiveConfig('text'))?.model, 'solo-text')
})

test('server start calls grsai bootstrap next to codecc', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /await bootstrapCodeccConfigs\(\)\s+await bootstrapGrsaiConfigs\(\)/)
})
