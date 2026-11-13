import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, beforeEach } from 'node:test'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'

const storageDir = mkdtempSync(path.join(tmpdir(), 'huobao-global-character-image-'))
process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.STORAGE_PATH = path.join(storageDir, 'static')

const { db, schema } = await import('../src/db/index.js')
const { default: globalCharacterRoutes } = await import('../src/routes/global-characters.js')
const { createSession, getSession } = await import('../src/services/rpg/engine.js')
const { writeBackImageAssets } = await import('../src/services/generation.js')
const { snapshotGlobalCharacterImage } = await import('../src/services/character-image.js')
const { mastra } = await import('../src/mastra/index.js')
const { imagePromptTools } = await import('../src/agents/tools/image-prompt-tools.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { agentRegistry } = await import('../src/agents/index.js')
const { characterImagePrompt } = await import('../src/services/asset-images.js')
const { generateGlobalCharacterFinalPrompt } = await import('../src/services/final-prompt.js')
const { withMockWorldAdaptation } = await import('./helpers/mock-world-adaptation.js')
const { enqueueAssetReferenceImage, isEpisodeAssetImagesPending } = await import('../src/services/asset-images.js')

const timestamp = new Date().toISOString()
db.insert(schema.stylePresets).values({
  name: '测试参考图风格', value: 'test-reference', prompt: 'test character reference style',
  createdAt: timestamp, updatedAt: timestamp,
}).run()
const headers = { 'content-type': 'application/json' }
const imageBody = JSON.stringify({ style: 'test-reference' })
const promptAgent = () => ({ generate: async (_messages: unknown, options: any) => {
  const { characters } = await imagePromptTools.readCharacters.execute!({}, options) as any
  const character = characters[0]
  return imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: character.id,
    prompt: `${characterImagePrompt(character)}, Agent 创作参考图` }, options)
} })
beforeEach(t => {
  t.mock.method(mastra, 'getAgent', promptAgent as any)
})

after(() => rmSync(storageDir, { recursive: true, force: true }))

async function waitForTask(id: number) {
  let task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  for (let attempt = 0; attempt < 500 && task?.status === 'processing'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  }
  return task
}

test('global character image generation saves a reusable portrait', async (t) => {
  const ts = new Date().toISOString()
  db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'openai', name: 'Test', baseUrl: 'https://images.example',
    apiKey: 'test-key', model: JSON.stringify(['gpt-image-2']), createdAt: ts, updatedAt: ts,
  }).run()
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
  const providerUrls: string[] = []
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    providerUrls.push(url)
    if (url === 'https://images.example/v1/images/generations' || url === 'https://images.example/v1/images/edits') {
      if (url.endsWith('/edits')) {
        assert.ok(init?.body instanceof FormData)
        assert.ok(init.body.getAll('image').length > 0)
      }
      return Response.json({ data: [{ b64_json: png.toString('base64') }] })
    }
    throw new Error(`Unexpected request: ${url}`)
  }) as typeof fetch)

  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '沈知遥', role: '钟表匠', appearance: '银灰短发，左眉有浅疤', physique: '清瘦挺拔', default_styling: '深绿色短外套',
  }) })
  assert.equal(created.status, 201)
  const character = (await created.json() as any).data

  const response = await globalCharacterRoutes.request(`/${character.id}/generate-image`, { method: 'POST', headers, body: imageBody })
  assert.equal(response.status, 200)
  const taskId = (await response.json() as any).data.image_generation_id
  const task = await waitForTask(taskId)

  assert.equal(task?.status, 'completed', task?.errorMsg || 'image task did not complete')
  assert.ok(task.localPath)
  const imagePath = path.join(storageDir, task.localPath)
  assert.equal(existsSync(imagePath), true)
  assert.deepEqual(readFileSync(imagePath), png)
  assert.equal(task.prompt?.includes('银灰短发，左眉有浅疤'), true)
  assert.equal(task.prompt?.includes('清瘦挺拔'), true)
  assert.equal(task.prompt?.includes('深绿色短外套'), true)
  assert.match(task.prompt || '', /Agent 创作参考图/)
  assert.match(task.prompt || '', /左侧为正脸特写/)
  assert.match(task.prompt || '', /正面、90 度侧面、背面/)
  assert.equal(task.prompt?.split('test character reference style').length, 2)
  const params = JSON.parse(task.params || '{}')
  assert.equal(params.globalCharacterId, character.id)
  assert.equal(params.size, '1920x1080')
  assert.equal(params.frameType, 'asset_reference')
  assert.deepEqual(params.globalCharacterImageStyle, { value: 'test-reference', prompt: 'test character reference style' })
  assert.equal(task.dramaId, null)
  assert.equal(task.characterId, null)

  const library = (await (await globalCharacterRoutes.request('/')).json() as any).data
  assert.equal(library.find((item: any) => item.id === character.id)?.image_url, task.localPath)
  const session = await withMockWorldAdaptation(() => createSession({ title: '复用角色图', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: character.id }))
  assert.ok(session?.player_character)
  const worldCharacterId = session!.player_character!.project_character_id
  for (let attempt = 0; attempt < 500 && isEpisodeAssetImagesPending(session.episode_id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const [worldTask] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.characterId, worldCharacterId))
  assert.ok(worldTask)
  const completedWorldTask = await waitForTask(worldTask.id)
  assert.equal(completedWorldTask?.status, 'completed', completedWorldTask?.errorMsg || 'world portrait did not complete')
  assert.equal(JSON.parse(completedWorldTask!.params || '{}').requireReferenceImages, true)
  assert.match(completedWorldTask!.prompt || '', /保持参考人物的同一张脸/)
  assert.match(completedWorldTask!.prompt || '', /本世界发型、妆容、服装和配饰/)
  const worldCharacter = db.select().from(schema.characters).where(eq(schema.characters.id, worldCharacterId)).get()!
  assert.notEqual(worldCharacter.imageUrl, task.localPath)
  assert.ok(JSON.parse(worldCharacter.referenceImages || '[]').includes(task.localPath))

  const regenerate = await globalCharacterRoutes.request(`/${character.id}/generate-image`, { method: 'POST', headers, body: imageBody })
  assert.equal(regenerate.status, 200)
  const regenerated = await waitForTask((await regenerate.json() as any).data.image_generation_id)
  assert.equal(regenerated?.status, 'completed', regenerated?.errorMsg || 'regeneration did not complete')
  assert.deepEqual(JSON.parse(regenerated.params || '{}').referenceImages, [task.localPath])
  assert.deepEqual(providerUrls, ['https://images.example/v1/images/generations', 'https://images.example/v1/images/edits', 'https://images.example/v1/images/edits'])
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, worldCharacterId)).get()?.imageUrl, worldCharacter.imageUrl)

  const oldTask = db.insert(schema.sysTask).values({ type: 'image', params: JSON.stringify({ globalCharacterId: character.id }), createdAt: ts, updatedAt: ts }).run()
  const newerTask = db.insert(schema.sysTask).values({ type: 'image', params: JSON.stringify({ globalCharacterId: character.id }), createdAt: ts, updatedAt: ts }).run()
  const oldRecord = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(oldTask.lastInsertRowid))).get()!
  const newRecord = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(newerTask.lastInsertRowid))).get()!
  await writeBackImageAssets(oldRecord, '/static/images/old-result.png')
  let stored = db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, character.id)).get()
  assert.equal(stored?.imageUrl, regenerated.localPath)
  await writeBackImageAssets(newRecord, '/static/images/new-result.png')
  stored = db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, character.id)).get()
  assert.equal(stored?.imageUrl, '/static/images/new-result.png')
})

test('a world portrait never falls back to text-only generation and can be retried', async (t) => {
  const ts = new Date().toISOString()
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
  const reference = `data:image/png;base64,${png.toString('base64')}`
  const id = Number(db.insert(schema.globalCharacters).values({
    name: '参考图重试角色', appearance: '眉间小痣', physique: '高挑', imageUrl: reference,
    createdAt: ts, updatedAt: ts,
  }).run().lastInsertRowid)
  let shouldFail = true
  const urls: string[] = []
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input))
    assert.ok(init?.body instanceof FormData)
    assert.ok(init.body.getAll('image').length > 0)
    return shouldFail ? new Response('unavailable', { status: 404 }) : Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as typeof fetch)
  const session = await withMockWorldAdaptation(() => createSession({
    title: '重试世界', premise: '一位旅人穿过山谷，来到一座陌生的边境城镇。', global_character_id: id,
  }))
  assert.ok(session?.player_character)
  for (let attempt = 0; attempt < 500 && isEpisodeAssetImagesPending(session.episode_id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const characterId = session.player_character.project_character_id
  const [first] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.characterId, characterId))
  assert.ok(first)
  assert.equal((await waitForTask(first.id))?.status, 'failed')
  assert.equal((await getSession(session.id))?.player_character?.image_status, 'failed')
  assert.deepEqual(urls, ['https://images.example/v1/images/edits'])
  shouldFail = false
  const retry = await enqueueAssetReferenceImage('character', characterId, { episodeId: session.episode_id })
  assert.ok(retry.taskId)
  assert.equal((await waitForTask(retry.taskId))?.status, 'completed')
  const current = await getSession(session.id)
  assert.equal(current?.player_character?.image_status, 'completed')
  assert.ok(current?.player_character?.image_url)
  assert.deepEqual(urls, ['https://images.example/v1/images/edits', 'https://images.example/v1/images/edits'])
})

test('concurrent requests submit a single global portrait task', async (t) => {
  const ts = new Date().toISOString()
  const inserted = db.insert(schema.globalCharacters).values({ name: '并发测试角色', createdAt: ts, updatedAt: ts }).run()
  const id = Number(inserted.lastInsertRowid)
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
  let releaseProvider!: () => void
  let providerStarted!: () => void
  const started = new Promise<void>(resolve => { providerStarted = resolve })
  const pending = new Promise<void>(resolve => { releaseProvider = resolve })
  let providerRequests = 0
  t.mock.method(globalThis, 'fetch', (async () => {
    providerRequests++
    providerStarted()
    await pending
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as typeof fetch)
  const request = () => globalCharacterRoutes.request(`/${id}/generate-image`, {
    method: 'POST', headers, body: imageBody,
  })
  let taskId = 0
  try {
    const responses = await Promise.all([request(), request()])
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400])
    taskId = (await responses.find(response => response.status === 200)!.json() as any).data.image_generation_id
    await started
    const duplicate = await request()
    assert.equal(duplicate.status, 400)
    assert.match((await duplicate.json() as any).message, /正在生成/)
  } finally {
    releaseProvider()
    if (taskId) assert.equal((await waitForTask(taskId))?.status, 'completed')
  }
  assert.equal(providerRequests, 1)
})

test('global portrait writeback preserves later image or appearance changes and deleted characters', async () => {
  const ts = new Date().toISOString()
  for (const change of [{ imageUrl: '/static/manual.png' }, { appearance: '新的外貌' }, { deletedAt: ts }]) {
    const inserted = db.insert(schema.globalCharacters).values({
      name: '过期结果测试角色', imageUrl: '/static/old.png', appearance: '原始外貌', createdAt: ts, updatedAt: ts,
    }).run()
    const id = Number(inserted.lastInsertRowid)
    const before = db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id)).get()!
    const task = db.insert(schema.sysTask).values({ type: 'image',
      params: JSON.stringify({ globalCharacterId: id, globalCharacterImageSource: snapshotGlobalCharacterImage(before) }),
      createdAt: ts, updatedAt: ts,
    }).run()
    const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(task.lastInsertRowid))).get()!
    db.update(schema.globalCharacters).set(change).where(eq(schema.globalCharacters.id, id)).run()
    await writeBackImageAssets(record, '/static/generated.png')
    const after = db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id)).get()!
    assert.equal(after.imageUrl, change.imageUrl || before.imageUrl)
    if (change.deletedAt) {
      const response = await globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST' })
      assert.equal(response.status, 404)
    }
  }
})

test('invalid or unconfigured portrait requests do not create tasks', async (t) => {
  const invalid = await globalCharacterRoutes.request('/invalid/generate-image', { method: 'POST' })
  assert.equal(invalid.status, 400)
  const missing = await globalCharacterRoutes.request('/999999/generate-image', { method: 'POST' })
  assert.equal(missing.status, 404)
  const ts = new Date().toISOString()
  const inserted = db.insert(schema.globalCharacters).values({ name: '未配置图片模型', createdAt: ts, updatedAt: ts }).run()
  const id = Number(inserted.lastInsertRowid)
  const before = db.select().from(schema.sysTask).all().length
  let calls = 0
  t.mock.method(mastra, 'getAgent', (() => { calls++; return promptAgent() }) as any)
  db.insert(schema.stylePresets).values({ name: '停用风格', value: 'disabled-reference', prompt: 'disabled', isActive: false, createdAt: ts, updatedAt: ts }).run()
  for (const style of [undefined, '', 'missing-reference', 'disabled-reference']) {
    const response = await globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST', headers, body: JSON.stringify({ style }) })
    assert.equal(response.status, 400)
    assert.match((await response.json() as any).message, /视觉风格/)
  }
  assert.equal(calls, 0)
  const configs = db.select().from(schema.aiServiceConfigs).all()
  try {
    db.update(schema.aiServiceConfigs).set({ isActive: false }).run()
    const response = await globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST', headers, body: imageBody })
    assert.equal(response.status, 400)
    assert.match((await response.json() as any).message, /未配置图片模型/)
  } finally {
    for (const config of configs) db.update(schema.aiServiceConfigs).set({ isActive: config.isActive }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  }
  assert.equal(db.select().from(schema.sysTask).all().length, before)
})

test('global prompt context restricts the shared agent to its target and maps character defaults', async () => {
  const character = { id: 7, name: '目标角色', role: '医师', appearance: '黑色短发', physique: '高挑', styling: '白色衬衫', personality: '沉静' }
  const state = { character, stylePrompt: 'anime reference', finalPrompt: undefined as string | undefined }
  // 即使上下文意外带了项目 ID，全局角色任务仍不能访问项目资产。
  const requestContext = buildAgentRequestContext({ episodeId: 1, dramaId: 1, globalCharacterPrompt: state })
  const context = { requestContext } as any
  const before = db.select().from(schema.characters).all()
  const result = await imagePromptTools.readCharacters.execute!({}, context) as any
  assert.deepEqual(result.characters, [{ ...character, description: character.appearance, final_prompt: '' }])
  const wrong = await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: 8, prompt: '错误角色' }, context) as any
  assert.match(wrong.error, /指定/)
  assert.equal(state.finalPrompt, undefined)
  const empty = await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: 7, prompt: '   ' }, context) as any
  assert.match(empty.error, /不能为空/)
  const saved = await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: 7, prompt: '正脸特写与三视图' }, context) as any
  assert.equal(saved.final_prompt, 'anime reference, 正脸特写与三视图')
  assert.equal(state.finalPrompt, saved.final_prompt)
  const sceneResult = await imagePromptTools.readScenes.execute!({}, context) as any
  assert.ok(sceneResult.error)
  assert.deepEqual(db.select().from(schema.characters).all(), before)
  const tools = await agentRegistry.prompt_generator.listTools({ requestContext })
  assert.deepEqual(Object.keys(tools).sort(), ['readCharacters', 'saveCharacterFinalPrompt'])
  const instructions = await agentRegistry.prompt_generator.getInstructions({ requestContext })
  assert.match(String(instructions), /左侧正脸特写|左侧：正脸特写/)
  assert.match(String(instructions), /本次仅为指定全局角色/)
})

test('global portraits use the shared reference sheet fallback when the agent fails or saves no prompt', async (t) => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
  t.mock.method(globalThis, 'fetch', (async () => Response.json({ data: [{ b64_json: png.toString('base64') }] })) as typeof fetch)
  for (const throws of [true, false]) {
    const ts = new Date().toISOString()
    const inserted = db.insert(schema.globalCharacters).values({ name: '兜底角色', appearance: '银色长发', createdAt: ts, updatedAt: ts }).run()
    const id = Number(inserted.lastInsertRowid)
    t.mock.method(mastra, 'getAgent', (() => ({ generate: async () => { if (throws) throw new Error('提示词服务不可用') } })) as any)
    const response = await globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST', headers, body: imageBody })
    assert.equal(response.status, 200)
    const task = await waitForTask((await response.json() as any).data.image_generation_id)
    assert.equal(task?.status, 'completed')
    assert.match(task.prompt || '', /^test character reference style,/)
    assert.match(task.prompt || '', /正脸特写/)
    assert.match(task.prompt || '', /正面、90 度侧面、背面/)
    assert.match(task.prompt || '', /银色长发/)
    assert.doesNotMatch(task.prompt || '', /半身|Agent 创作/)
  }
})

test('prompt preparation holds the submission lock and rejects later character changes or deletion', async (t) => {
  const ts = new Date().toISOString()
  for (const change of [{ name: '新姓名' }, { role: '新身份' }, { defaultPersonality: '新性格' }, { appearance: '新外貌' },
    { physique: '新身材' }, { defaultStyling: '新服装' }, { imageUrl: '/static/new.png' }, { referenceImages: '["/static/new.png"]' }, { deletedAt: ts }]) {
    const inserted = db.insert(schema.globalCharacters).values({ name: '准备中的角色', createdAt: ts, updatedAt: ts }).run()
    const id = Number(inserted.lastInsertRowid)
    const before = db.select().from(schema.sysTask).all().length
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    t.mock.method(mastra, 'getAgent', (() => ({ generate: async () => { started(); await waiting } })) as any)
    const request = () => globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST', headers, body: imageBody })
    const pending = request()
    try {
      await ready
      const duplicate = await request()
      assert.equal(duplicate.status, 400)
      assert.match((await duplicate.json() as any).message, /正在提交/)
      db.update(schema.globalCharacters).set(change).where(eq(schema.globalCharacters.id, id)).run()
    } finally { release() }
    const response = await pending
    assert.equal(response.status, 'deletedAt' in change ? 404 : 400)
    assert.equal(db.select().from(schema.sysTask).all().length, before)
  }
})

test('each generation creates a fresh prompt with its chosen style and forwards model overrides', async (t) => {
  const ts = new Date().toISOString()
  db.insert(schema.stylePresets).values({ name: '另一种风格', value: 'other-reference', prompt: 'other reference style', createdAt: ts, updatedAt: ts }).run()
  const inserted = db.insert(schema.globalCharacters).values({ name: '换风格角色', role: '作家', defaultPersonality: '开朗', createdAt: ts, updatedAt: ts }).run()
  const id = Number(inserted.lastInsertRowid)
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#abcdef' } }).png().toBuffer()
  t.mock.method(globalThis, 'fetch', (async () => Response.json({ data: [{ b64_json: png.toString('base64') }] })) as typeof fetch)
  const calls: unknown[] = []
  t.mock.method(mastra, 'getAgent', ((name: string) => {
    assert.equal(name, 'prompt_generator')
    return { generate: async (messages: unknown, options: any) => {
      calls.push(messages)
      assert.equal(options.requestContext.get('modelOverride'), 'test-text-model')
      assert.equal(options.requestContext.get('textConfigId'), 123)
      assert.equal(options.requestContext.get('dramaId'), undefined)
      assert.equal(options.requestContext.get('episodeId'), undefined)
      return promptAgent().generate(messages, options)
    } }
  }) as any)
  for (const style of ['test-reference', 'other-reference']) {
    const response = await globalCharacterRoutes.request(`/${id}/generate-image`, { method: 'POST', headers,
      body: JSON.stringify({ style, model: 'gpt-image-2', text_model: 'test-text-model', text_config_id: 123 }) })
    assert.equal(response.status, 200)
    const task = await waitForTask((await response.json() as any).data.image_generation_id)
    assert.equal(task?.status, 'completed')
    assert.equal(task.model, 'gpt-image-2')
    assert.match(task.prompt || '', style === 'test-reference' ? /^test character reference style,/ : /^other reference style,/)
    assert.match(task.prompt || '', /Agent 创作参考图/)
    assert.equal(JSON.parse(task.params || '{}').globalCharacterImageStyle.value, style)
  }
  assert.equal(calls.length, 2)
})

test('the registered prompt agent reads and saves a global reference prompt through its real tool loop', async (t) => {
  const ts = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text', provider: 'openai', name: 'Prompt integration', baseUrl: 'https://text.example',
    apiKey: 'test-key', model: JSON.stringify(['test-text-model']), createdAt: ts, updatedAt: ts,
  }).run()
  const inserted = db.insert(schema.globalCharacters).values({
    name: '真实工具链角色', appearance: '栗色短发', physique: '高挑', defaultStyling: '灰色长衣',
    createdAt: ts, updatedAt: ts,
  }).run()
  const character = db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, Number(inserted.lastInsertRowid))).get()!
  const before = db.select().from(schema.characters).all()
  const referencePrompt = '角色设定参考图，左侧正脸特写，右侧正面、90 度侧面、背面三张全身视图，栗色短发，高挑，灰色长衣'
  let calls = 0
  t.mock.method(mastra, 'getAgent', (() => agentRegistry.prompt_generator) as any)
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://text.example/v1/chat/completions')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'test-text-model')
    calls++
    assert.ok(calls <= 3, 'prompt agent must finish after reading and saving')
    const toolNames = body.tools.map((tool: any) => tool.function.name)
    assert.ok(toolNames.includes('readCharacters'))
    assert.ok(toolNames.includes('saveCharacterFinalPrompt'))
    assert.ok(!toolNames.includes('saveSceneFinalPrompt'))
    assert.match(body.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n'), /Character|角色/)
    if (calls === 2) {
      const readResult = body.messages.findLast((message: any) => message.role === 'tool')
      assert.match(readResult?.content || '', /真实工具链角色/)
      assert.match(readResult?.content || '', /栗色短发/)
      assert.match(readResult?.content || '', /灰色长衣/)
    }
    if (calls === 3) {
      const saveResult = body.messages.findLast((message: any) => message.role === 'tool')
      assert.match(saveResult?.content || '', /integration style/)
    }
    const toolCall = calls < 3 ? {
      id: `call_${calls}`, type: 'function', function: {
        name: calls === 1 ? 'readCharacters' : 'saveCharacterFinalPrompt',
        arguments: JSON.stringify(calls === 1 ? {} : { character_id: character.id, prompt: referencePrompt }),
      },
    } : undefined
    const finishReason = toolCall ? 'tool_calls' : 'stop'
    if (!body.stream) {
      return Response.json({
        id: `chat_${calls}`, object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : '已保存', ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    }
    const delta = toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: '已保存' }
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    return new Response([
      chunk({ id: `chat_${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }),
      chunk({ id: `chat_${calls}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch)

  const finalPrompt = await generateGlobalCharacterFinalPrompt(character, 'integration style', {
    model: 'test-text-model', configId: Number(config.lastInsertRowid),
  })
  assert.equal(finalPrompt, `integration style, ${referencePrompt}`)
  assert.equal(calls, 3)
  assert.deepEqual(db.select().from(schema.characters).all(), before)
})
