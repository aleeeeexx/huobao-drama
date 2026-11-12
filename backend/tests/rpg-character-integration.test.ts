import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'

process.env.SQLITE_PATH = ':memory:'
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.js')
const { createSession, getSession, narrateSession, updateSessionPlayerCharacter } = await import('../src/services/rpg/engine.js')
const { default: characterRoutes } = await import('../src/routes/characters.js')
const { extractTools } = await import('../src/agents/tools/extract-tools.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { default: globalCharacterRoutes } = await import('../src/routes/global-characters.js')
const { default: episodeRoutes } = await import('../src/routes/episodes.js')
const { writeBackImageAssets } = await import('../src/services/generation.js')
const { parseCharacterReferenceImages } = await import('../src/services/character-image.js')
const { imagePromptTools } = await import('../src/agents/tools/image-prompt-tools.js')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')
const { exportNovelToText } = await import('../src/services/novel/project.js')
const { enqueueAssetReferenceImage, isEpisodeAssetImagesPending } = await import('../src/services/asset-images.js')
const { mastra } = await import('../src/mastra/index.js')

test('image submission rejects a revision changed after its initial check', async (t) => {
  const ts = new Date().toISOString()
  const drama = db.insert(schema.dramas).values({ title: '并发提交', createdAt: ts, updatedAt: ts }).run()
  const dramaId = Number(drama.lastInsertRowid)
  const episode = db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '开场', createdAt: ts, updatedAt: ts }).run()
  const character = db.insert(schema.characters).values({ dramaId, name: '并发角色', finalPrompt: '旧提示词', createdAt: ts, updatedAt: ts }).run()
  const id = Number(character.lastInsertRowid)
  const select = db.select.bind(db)
  let changed = false
  t.mock.method(db, 'select', ((...args: unknown[]) => {
    const query = (select as any)(...args)
    const from = query.from.bind(query)
    query.from = (table: unknown) => {
      if (table === schema.dramas && !changed) {
        changed = true
        db.update(schema.characters).set({ imageRevision: 1, appearance: '新外貌' }).where(eq(schema.characters.id, id)).run()
      }
      return from(table)
    }
    return query
  }) as typeof db.select)
  await assert.rejects(enqueueAssetReferenceImage('character', id, { episodeId: Number(episode.lastInsertRowid) }), /角色资料已更新/)
  assert.equal(changed, true)
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.characterId, id))
  assert.equal(tasks.length, 0)
})

test('existing SQLite character rows receive an image revision', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec("CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO characters (id, name) VALUES (1, 'old')")
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare('SELECT name, image_revision, final_prompt_auto, image_auto FROM characters WHERE id = 1').get(),
      { name: 'old', image_revision: 0, final_prompt_auto: 0, image_auto: 0 })
  } finally {
    sqlite.close()
  }
})

test('existing global character rows receive life profile columns', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.exec(`CREATE TABLE global_characters (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); INSERT INTO global_characters (id, name, created_at, updated_at) VALUES (1, 'old', 't', 't')`)
    initSqliteSchema(sqlite)
    assert.deepEqual(sqlite.prepare(`SELECT default_values, default_speech, default_habits, default_desires,
      default_fears, default_relationships, default_abilities, default_background
      FROM global_characters WHERE id = 1`).get(), {
      default_values: null,
      default_speech: null,
      default_habits: null,
      default_desires: null,
      default_fears: null,
      default_relationships: null,
      default_abilities: null,
      default_background: null,
    })
  } finally {
    sqlite.close()
  }
})

test('global character life defaults round-trip through the library API', async () => {
  const headers = { 'content-type': 'application/json' }
  const longValue = '值'.repeat(2001)
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '沈知遥', role: '钟表匠', appearance: '银灰色短发', physique: longValue,
    default_personality: '克制', default_values: '把真相说完', default_speech: '先问再判断',
    default_habits: '随身带笔记', default_desires: '找到委托人', default_fears: '看漏裂痕',
    default_relationships: '记挂老钟表匠', default_abilities: '修理钟表', default_background: longValue,
    default_styling: '深绿短外套',
  }) })
  assert.equal(created.status, 201)
  const createdBody = (await created.json() as any).data
  const id = createdBody.id
  assert.equal(createdBody.physique.length, 2000)
  assert.equal(createdBody.default_background.length, 2000)
  const updated = await globalCharacterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({
    default_values: longValue,
  }) })
  assert.equal(updated.status, 200)
  const body = await updated.json() as any
  assert.equal(body.data.default_values.length, 2000)
  assert.equal(body.data.default_relationships, '记挂老钟表匠')
  assert.equal(body.data.appearance, '银灰色短发')
})

test('player life edits do not replace the portrait', async () => {
  const session = await createSession({ title: '生活细节不换脸', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/face.png', localPath: '/static/face.png', imageAuto: true, imageRevision: 3 })
    .where(eq(schema.characters.id, id))
  await updateSessionPlayerCharacter(session.id, { personality: '更温和', values: '守信' })
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/face.png')
  assert.equal(character.imageRevision, 3)
  assert.equal((await getSession(session.id))?.player_character?.values, '守信')
  await updateSessionPlayerCharacter(session.id, { styling: '新斗篷' })
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, null)
  assert.equal(character.imageRevision, 4)
})

test('opening adaptation keeps the portrait when clothing does not change', async () => {
  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '林雾', role: '医生', appearance: '短发', physique: '清瘦', default_styling: '深色风衣',
    default_personality: '先听后判断', default_values: '先救人', default_speech: '短句，不催问',
    default_habits: '进门先看窗', default_desires: '找到老师', default_fears: '再次迟到',
    default_relationships: '记挂老师和邻居孩子', default_abilities: '外伤处理', default_background: '在边境诊所长大',
  }) })
  const global = (await created.json() as any).data
  const session = await createSession({ title: '服装未变', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/face.png', localPath: '/static/face.png', imageAuto: true, imageRevision: 2 })
    .where(eq(schema.characters.id, id))
  await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /未配置文本模型/)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/face.png')
  assert.equal(character.imageRevision, 2)
  const player = (await getSession(session.id))?.player_character
  assert.equal(player?.values, '先救人')
  assert.equal(player?.personality, '先听后判断')
  assert.equal(player?.speech, '短句，不催问')
  assert.equal(player?.habits, '进门先看窗')
  assert.equal(player?.desires, '找到老师')
  assert.equal(player?.fears, '再次迟到')
  assert.equal(player?.relationships, '记挂老师和邻居孩子')
  assert.equal(player?.abilities, '外伤处理')
  assert.equal(player?.background, '在边境诊所长大')
  assert.equal(player?.appearance, '短发')
  assert.equal(player?.physique, '清瘦')
  assert.equal(player?.adapted, true)
})

test('opening adaptation replaces an automatic portrait when fallback clothing changes', async () => {
  const headers = { 'content-type': 'application/json' }
  const created = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '林雾改衣', default_styling: '深色风衣', appearance: '短发', physique: '清瘦',
  }) })
  const global = (await created.json() as any).data
  const session = await createSession({ title: '服装改变', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  const snapshot = { ...session.player_character, styling: '旧衣服' }
  await db.update(schema.rpgSessions).set({ playerCharacter: JSON.stringify(snapshot) }).where(eq(schema.rpgSessions.id, session.id))
  await db.update(schema.characters).set({ styling: '旧衣服', imageUrl: '/static/auto.png', localPath: '/static/auto.png', imageAuto: true, imageRevision: 1 })
    .where(eq(schema.characters.id, id))
  await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /未配置文本模型/)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.styling, '深色风衣')
  assert.equal(character.imageUrl, null)
  assert.equal(character.imageRevision, 2)
  assert.equal(character.appearance, '短发')
})

test('startup repairs deleted global links and previously deleted RPG players', () => {
  const sqlite = new Database(':memory:')
  try {
    initSqliteSchema(sqlite)
    sqlite.exec(`
      INSERT INTO global_characters (id, name, created_at, updated_at, deleted_at) VALUES
        (1, 'deleted', 't', 't', 't'), (2, 'active', 't', 't', NULL);
      INSERT INTO characters (id, drama_id, global_character_id, name, image_url, created_at, updated_at, deleted_at) VALUES
        (1, 10, 1, 'player', '/static/player.png', 't', 't', 't'),
        (2, 10, NULL, 'other deleted', NULL, 't', 't', 't'),
        (3, 10, 2, 'active global', NULL, 't', 't', NULL),
        (4, 10, 99, 'missing global', NULL, 't', 't', NULL),
        (5, 11, NULL, 'malformed snapshot', NULL, 't', 't', 't'),
        (6, 12, NULL, 'novel player', NULL, 't', 't', 't'),
        (7, 13, NULL, 'other drama', NULL, 't', 't', 't'),
        (8, 14, NULL, 'boolean snapshot', NULL, 't', 't', 't');
      INSERT INTO rpg_sessions (world_id, drama_id, episode_id, title, world_state, player_character, play_kind, created_at, updated_at) VALUES
        (1, 10, 1, 'rpg', '{}', '{"project_character_id":1}', 'rpg', 't', 't'),
        (1, 11, 1, 'malformed', '{}', '{', 'rpg', 't', 't'),
        (1, 12, 1, 'novel', '{}', '{"project_character_id":6}', 'novel', 't', 't'),
        (1, 10, 1, 'other drama', '{}', '{"project_character_id":7}', 'rpg', 't', 't'),
        (1, 14, 1, 'boolean', '{}', '{"project_character_id":true}', 'rpg', 't', 't');
    `)
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)
    const rows = sqlite.prepare('SELECT id, global_character_id, manual_override, image_url, deleted_at FROM characters ORDER BY id').all()
    assert.deepEqual(rows, [
      { id: 1, global_character_id: null, manual_override: 1, image_url: '/static/player.png', deleted_at: null },
      { id: 2, global_character_id: null, manual_override: 0, image_url: null, deleted_at: 't' },
      { id: 3, global_character_id: 2, manual_override: 0, image_url: null, deleted_at: null },
      { id: 4, global_character_id: null, manual_override: 1, image_url: null, deleted_at: null },
      { id: 5, global_character_id: null, manual_override: 0, image_url: null, deleted_at: 't' },
      { id: 6, global_character_id: null, manual_override: 0, image_url: null, deleted_at: 't' },
      { id: 7, global_character_id: null, manual_override: 0, image_url: null, deleted_at: 't' },
      { id: 8, global_character_id: null, manual_override: 0, image_url: null, deleted_at: 't' },
    ])
  } finally {
    sqlite.close()
  }
})

test('deleting a bound protagonist is rejected while other characters can be deleted', async () => {
  const session = await createSession({ title: '主角删除保护', premise: '一位旅人穿过山谷，来到一座陌生的边境城镇。' })
  assert.ok(session?.player_character)
  const playerId = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/player.png' }).where(eq(schema.characters.id, playerId))
  const rejected = await characterRoutes.request(`/${playerId}`, { method: 'DELETE' })
  assert.equal(rejected.status, 400)
  assert.match((await rejected.json() as any).message, /本局主角无法删除/)
  let current = await getSession(session.id)
  assert.equal(current?.player_character?.project_character_id, playerId)
  assert.equal(current?.player_character?.image_url, '/static/player.png')
  assert.ok(current?.assets.characters.some(character => character.id === playerId))

  const created = await characterRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drama_id: session.drama_id, episode_id: session.episode_id, name: '可删除的配角' }) })
  const otherId = (await created.json() as any).data.id
  assert.equal((await characterRoutes.request(`/${otherId}`, { method: 'DELETE' })).status, 200)
  current = await getSession(session.id)
  assert.equal(current?.assets.characters.some(character => character.id === otherId), false)
  assert.ok(current?.assets.characters.some(character => character.id === playerId))
})

test('player edits stay synchronized and survive character extraction', async () => {
  const session = await createSession({ title: '测试世界', premise: '一位旅行者来到新世界，在陌生的城镇寻找失散的朋友。', genre: '奇幻' })
  assert.ok(session?.player_character)
  const characterId = session.player_character.project_character_id
  const [created] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  assert.equal(created.manualOverride, true)

  await updateSessionPlayerCharacter(session.id, { personality: '谨慎', background: '来自北方', styling: '蓝色斗篷' })
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  assert.equal(character.background, '来自北方')
  assert.equal(character.manualOverride, true)

  const response = await characterRoutes.request(`/${characterId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: '医师', appearance: '短发', physique: '高挑', personality: '坚定', background: '在南方长大', styling: '白色长袍' }),
  })
  assert.equal(response.status, 200)
  const updated = await getSession(session.id)
  assert.equal(updated?.player_character?.role, '医师')
  assert.equal(updated?.player_character?.appearance, '短发')
  assert.equal(updated?.player_character?.background, '在南方长大')
  assert.equal(updated?.player_character?.personality, '坚定')
  assert.equal(updated?.player_character?.image_url, '')

  // Existing sessions may predate the manual override flag.
  await db.update(schema.characters).set({ manualOverride: false }).where(eq(schema.characters.id, characterId))
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
  await extractTools.saveDedupCharacters.execute!({ characters: [{ name: created.name, personality: '胆小', background: '错误经历', styling: '旧衣服' }] }, { requestContext } as any)
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  assert.equal(character.personality, '坚定')
  assert.equal(character.background, '在南方长大')
  assert.equal(character.styling, '白色长袍')
})

test('cleared asset image does not fall back to the old player snapshot', async () => {
  const session = await createSession({ title: '参考图世界', premise: '一位旅人穿过漫长的山谷，寻找城镇中的一位旧友。', genre: '奇幻' })
  assert.ok(session?.player_character)
  const snapshot = { ...session.player_character, image_url: '/static/old.png' }
  await db.update(schema.rpgSessions).set({ playerCharacter: JSON.stringify(snapshot) }).where(eq(schema.rpgSessions.id, session.id))
  await db.update(schema.characters).set({ imageUrl: null, localPath: null }).where(eq(schema.characters.id, snapshot.project_character_id))
  assert.equal((await getSession(session.id))?.player_character?.image_url, '')
  await db.update(schema.characters).set({ localPath: '/static/new.png' }).where(eq(schema.characters.id, snapshot.project_character_id))
  assert.equal((await getSession(session.id))?.player_character?.image_url, '/static/new.png')
})

test('saving an unchanged player to the global library keeps the portrait', async () => {
  const session = await createSession({ title: '角色保存', premise: '一位旅行者来到陌生城镇寻找多年未见的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/portrait.png' }).where(eq(schema.characters.id, id))
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  const update = await characterRoutes.request(`/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: character.role, description: character.description, appearance: character.appearance,
      physique: character.physique, personality: character.personality, background: character.background, styling: character.styling }),
  })
  assert.equal(update.status, 200)
  const saved = await characterRoutes.request(`/${id}/save-global`, { method: 'POST' })
  assert.equal(saved.status, 201)
  assert.equal((await saved.json() as any).data.image_url, '/static/portrait.png')
})

test('saving an edited player keeps the previous portrait as a reference and global avatar', async () => {
  const session = await createSession({ title: '编辑后保存', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ imageUrl: '/static/previous.png' }).where(eq(schema.characters.id, id))
  const updated = await characterRoutes.request(`/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '编辑保存角色', appearance: '新的外貌' }),
  })
  assert.equal(updated.status, 200)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, null)
  assert.deepEqual(parseCharacterReferenceImages(character.referenceImages), ['/static/previous.png'])
  const saved = await characterRoutes.request(`/${id}/save-global`, { method: 'POST' })
  assert.equal(saved.status, 201)
  assert.equal((await saved.json() as any).data.image_url, '/static/previous.png')
})

test('editing a story character invalidates its image and rejects old image tasks', async () => {
  const session = await createSession({ title: '剧情人物图片', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session)
  const headers = { 'content-type': 'application/json' }
  const response = await characterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    drama_id: session.drama_id, episode_id: session.episode_id, name: '配角', appearance: '旧外貌',
  }) })
  const id = (await response.json() as any).data.id
  await db.update(schema.characters).set({ imageUrl: '/static/old.png', finalPrompt: '旧提示词', finalPromptAuto: true }).where(eq(schema.characters.id, id))
  const ts = new Date().toISOString()
  const inserted = await db.insert(schema.sysTask).values({
    type: 'image', characterId: id, params: JSON.stringify({ characterImageRevision: 0 }),
    status: 'processing', createdAt: ts, updatedAt: ts,
  })
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(inserted.lastInsertRowid)))
  assert.equal((await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ appearance: '新外貌' }) })).status, 200)
  await writeBackImageAssets(task, '/static/late-old.png')
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.appearance, '新外貌')
  assert.equal(character.imageRevision, 1)
  assert.equal(character.imageUrl, null)
  assert.equal(character.finalPrompt, null)
  assert.deepEqual(parseCharacterReferenceImages(character.referenceImages), ['/static/old.png'])
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ appearance: '新外貌' }) })
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageRevision, 1)
})

test('generation task status includes asset preparation before an image task exists', async (t) => {
  const session = await createSession({ title: '补图状态', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  for (let attempt = 0; attempt < 100 && isEpisodeAssetImagesPending(session.episode_id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(isEpisodeAssetImagesPending(session.episode_id), false)
  await db.update(schema.characters).set({ imageUrl: '/static/old.png', localPath: '/static/old.png',
    finalPrompt: '旧提示词', finalPromptAuto: true }).where(eq(schema.characters.id, id))
  let release = () => {}
  const waiting = new Promise<void>(resolve => { release = resolve })
  let preparing = false
  t.mock.method(mastra, 'getAgent', (() => ({ generate: async () => {
    preparing = true
    await waiting
  } })) as any)
  try {
    const response = await characterRoutes.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appearance: '新外貌' }) })
    assert.equal(response.status, 200)
    for (let attempt = 0; attempt < 100 && !preparing; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(preparing, true)
    const pending = await episodeRoutes.request(`/${session.episode_id}/generation-tasks`)
    const data = (await pending.json() as any).data
    assert.equal(data.asset_images_pending, true)
    assert.equal(data.tasks.some((task: any) => task.character_id === id), false)
  } finally {
    release()
  }
  for (let attempt = 0; attempt < 100 && isEpisodeAssetImagesPending(session.episode_id); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const finished = await episodeRoutes.request(`/${session.episode_id}/generation-tasks`)
  assert.equal((await finished.json() as any).data.asset_images_pending, false)
})

test('changing the player clears an uncommitted opening but keeps a committed one', async () => {
  const session = await createSession({ title: '开场重试', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  await updateSessionPlayerCharacter(session.id, {})
  const [row] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  const novel = JSON.parse(row.novelState!)
  novel.chapters['1'] = '旧开场正文'
  novel.coreSeed = '旧角色设定'
  await db.update(schema.rpgSessions).set({ novelState: JSON.stringify(novel) }).where(eq(schema.rpgSessions.id, session.id))
  await db.update(schema.episodes).set({ content: exportNovelToText(novel), scriptContent: '' }).where(eq(schema.episodes.id, session.episode_id))
  await updateSessionPlayerCharacter(session.id, { appearance: '新外貌' })
  let [updated] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  let [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
  assert.equal(JSON.parse(updated.novelState!).chapters['1'], undefined)
  assert.equal(JSON.parse(updated.novelState!).coreSeed, '')
  assert.doesNotMatch(episode.content || '', /旧开场正文/)
  assert.doesNotMatch(episode.scriptContent || '', /旧开场剧本/)
  novel.chapters['1'] = '已提交的开场'
  await db.update(schema.rpgSessions).set({ novelState: JSON.stringify(novel), turnCount: 1 }).where(eq(schema.rpgSessions.id, session.id))
  await db.insert(schema.rpgTurns).values({ sessionId: session.id, turnIndex: 1, playerMode: 'opening', narrative: '已提交的开场', choices: '[]', worldState: '{}', createdAt: new Date().toISOString() })
  await updateSessionPlayerCharacter(session.id, { appearance: '再次修改' })
  ;[updated] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  assert.equal(JSON.parse(updated.novelState!).chapters['1'], '已提交的开场')
})

test('changing the player preserves an uncommitted opening edited in the studio', async () => {
  const session = await createSession({ title: '保留手写开场', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  await updateSessionPlayerCharacter(session.id, {})
  const [row] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, session.id))
  const novel = JSON.parse(row.novelState!)
  novel.chapters['1'] = '自动开场'
  await db.update(schema.rpgSessions).set({ novelState: JSON.stringify(novel) }).where(eq(schema.rpgSessions.id, session.id))
  const handwrittenScript = '## S1 旧场景\n手写剧本\n\n## 人物设定\n请保留'
  await db.update(schema.episodes).set({ content: '手写正文', scriptContent: handwrittenScript }).where(eq(schema.episodes.id, session.episode_id))
  await assert.rejects(updateSessionPlayerCharacter(session.id, { appearance: '新外貌' }), /制作台备份/)
  let [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
  assert.equal(episode.content, '手写正文')
  assert.equal(episode.scriptContent, handwrittenScript)
  assert.equal((await getSession(session.id))?.player_character?.appearance, session.player_character.appearance)
  await db.update(schema.episodes).set({ content: exportNovelToText(novel) }).where(eq(schema.episodes.id, session.episode_id))
  await assert.rejects(updateSessionPlayerCharacter(session.id, { appearance: '新外貌' }), /制作台备份/)
  ;[episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, session.episode_id))
  assert.equal(episode.scriptContent, handwrittenScript)
})

test('extraction invalidates stale character assets without undoing manual fields', async () => {
  const session = await createSession({ title: '提取角色图片', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session)
  const response = await characterRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drama_id: session.drama_id, episode_id: session.episode_id, name: '配角', role: '医师' }) })
  const id = (await response.json() as any).data.id
  await db.update(schema.characters).set({ imageUrl: '/static/old.png', finalPrompt: '旧提示词', finalPromptAuto: true }).where(eq(schema.characters.id, id))
  const timestamp = new Date().toISOString()
  const inserted = await db.insert(schema.sysTask).values({ type: 'image', characterId: id,
    params: JSON.stringify({ characterImageRevision: 0 }), status: 'processing', createdAt: timestamp, updatedAt: timestamp })
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(inserted.lastInsertRowid)))
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
  await extractTools.saveDedupCharacters.execute!({ characters: [{ name: '配角', role: '商人', appearance: '短发' }] }, { requestContext } as any)
  await writeBackImageAssets(task, '/static/late.png')
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.role, '医师')
  assert.equal(character.appearance, '短发')
  assert.equal(character.imageRevision, 1)
  assert.equal(character.imageUrl, null)
  assert.equal(character.finalPrompt, null)
  assert.deepEqual(parseCharacterReferenceImages(character.referenceImages), ['/static/old.png'])
})

test('player edits, story character edits and extraction preserve handwritten prompts', async () => {
  const session = await createSession({ title: '保留手写提示词', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const headers = { 'content-type': 'application/json' }
  const playerId = session.player_character.project_character_id
  await characterRoutes.request(`/${playerId}`, { method: 'PUT', headers, body: JSON.stringify({ final_prompt: '主角手写提示词' }) })
  await updateSessionPlayerCharacter(session.id, { background: '新的经历' })
  let [player] = await db.select().from(schema.characters).where(eq(schema.characters.id, playerId))
  assert.equal(player.finalPrompt, '主角手写提示词')

  const created = await characterRoutes.request('/', { method: 'POST', headers,
    body: JSON.stringify({ drama_id: session.drama_id, episode_id: session.episode_id, name: '手写配角' }) })
  const id = (await created.json() as any).data.id
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ final_prompt: '配角手写提示词' }) })
  const edited = await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ appearance: '短发' }) })
  assert.equal((await edited.json() as any).data.final_prompt, '配角手写提示词')
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
  await extractTools.saveDedupCharacters.execute!({ characters: [{ name: '手写配角', physique: '高挑' }] }, { requestContext } as any)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.physique, '高挑')
  assert.equal(character.finalPrompt, '配角手写提示词')
})

test('manual image and prompt updates reject older background image tasks', async () => {
  const session = await createSession({ title: '手动上传', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  const timestamp = new Date().toISOString()
  const inserted = await db.insert(schema.sysTask).values({ type: 'image', characterId: id,
    params: JSON.stringify({ characterImageRevision: 0 }), status: 'processing', createdAt: timestamp, updatedAt: timestamp })
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(inserted.lastInsertRowid)))
  const headers = { 'content-type': 'application/json' }
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ image_url: '/static/upload.png', local_path: '/static/upload.png' }) })
  await writeBackImageAssets(task, '/static/late.png')
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/upload.png')
  assert.equal(character.imageRevision, 1)
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ final_prompt: '手写提示词' }) })
  await writeBackImageAssets({ ...task, params: JSON.stringify({ characterImageRevision: 1 }) }, '/static/late2.png')
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/upload.png')
  assert.equal(character.finalPrompt, '手写提示词')
  assert.equal(character.imageRevision, 2)
})

test('opening adaptation preserves a portrait uploaded after selecting a global character', async () => {
  const headers = { 'content-type': 'application/json' }
  const response = await globalCharacterRoutes.request('/', { method: 'POST', headers,
    body: JSON.stringify({ name: '开场上传角色', image_url: '/static/original.png' }) })
  const global = (await response.json() as any).data
  const session = await createSession({ title: '开场上传', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers,
    body: JSON.stringify({ image_url: '/static/uploaded.png', local_path: '/static/uploaded.png' }) })
  await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /未配置文本模型/)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/uploaded.png')
  assert.equal(character.localPath, '/static/uploaded.png')
})

test('character prompt tools expose physique and record generated prompt origin', async () => {
  const session = await createSession({ title: '身材提示词', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ physique: '高大健壮' }).where(eq(schema.characters.id, id))
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id })
  const result = await imagePromptTools.readCharacters.execute!({}, { requestContext } as any) as any
  assert.equal(result.characters.find((character: any) => character.id === id).physique, '高大健壮')
  await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: id, prompt: '自动提示词' }, { requestContext } as any)
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.finalPromptAuto, true)
  await characterRoutes.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ final_prompt: '手写提示词' }) })
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.finalPromptAuto, false)
})

test('opening adaptation preserves manual prompts and invalidates only stale generated prompts', async (t) => {
  const headers = { 'content-type': 'application/json' }
  const response = await globalCharacterRoutes.request('/', { method: 'POST', headers,
    body: JSON.stringify({ name: '提示词适配角色', default_styling: '旧衣服', image_url: '/static/portrait.png' }) })
  const global = (await response.json() as any).data
  const cases = ['manual', 'automatic', 'unchanged', 'concurrent', 'historic'] as const
  const sessions = await Promise.all(cases.map(title => createSession({ title,
    premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。', global_character_id: global.id })))
  await new Promise(resolve => setImmediate(resolve))
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai',
    name: '测试配置', baseUrl: 'https://example.invalid/v1', apiKey: 'test', model: '["test"]',
    createdAt: timestamp, updatedAt: timestamp }).run()
  let onAdapt = async () => {}
  let styling = '新衣服'
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    if (calls++ === 0) {
      await onAdapt()
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ personality: '坚定', background: '旅人', styling }) } }] }),
        { headers: { 'content-type': 'application/json' } })
    }
    return new Response('test failure', { status: 400 })
  })
  try {
    for (const [index, session] of sessions.entries()) {
      assert.ok(session?.player_character)
      const id = session.player_character.project_character_id
      await db.update(schema.characters).set({ finalPrompt: '原提示词', finalPromptAuto: index !== 0 && index !== 4 }).where(eq(schema.characters.id, id))
      if (index === 1) await characterRoutes.request(`/${id}`, { method: 'PUT', headers,
        body: JSON.stringify({ image_url: '/static/uploaded-before.png', local_path: '/static/uploaded-before.png' }) })
      if (index !== 0) {
        const revision = index === 1 ? 1 : 0
        await writeBackImageAssets({ characterId: id, params: JSON.stringify({ characterImageRevision: revision }) } as any, '/static/auto.png')
        const [generated] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
        assert.equal(generated.localPath, '/static/auto.png')
      }
      if (index === 4) await db.update(schema.characters).set({ localPath: '/static/older-upload.png' }).where(eq(schema.characters.id, id))
      if (index === 0) await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ final_prompt: '手写提示词' }) })
      styling = index === 2 ? '旧衣服' : '新衣服'
      calls = 0
      onAdapt = index === 3 ? async () => {
        const saved = await characterRoutes.request(`/${id}`, { method: 'PUT', headers, body: JSON.stringify({ final_prompt: '并发手写提示词', image_url: '/static/uploaded.png', local_path: '/static/uploaded.png' }) })
        assert.equal(saved.status, 200)
      } : async () => {}
      await assert.rejects(narrateSession(session.id, { mode: 'opening' }, () => {}), /小说章节生成失败/)
      const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
      assert.equal(character.finalPrompt, ['手写提示词', null, '原提示词', '并发手写提示词', '原提示词'][index])
      assert.equal(character.imageUrl, ['/static/portrait.png', null, '/static/auto.png', '/static/uploaded.png', null][index])
      assert.equal(character.localPath, [null, null, '/static/auto.png', '/static/uploaded.png', null][index])
      assert.equal((await getSession(session.id))?.player_character?.image_url,
        ['/static/portrait.png', '', '/static/auto.png', '/static/uploaded.png', ''][index])
      if (index === 4) await assert.rejects(enqueueAssetReferenceImage('character', id,
        { episodeId: session.episode_id, skipIfPresent: true }), /未配置图片模型/)
    }
  } finally {
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('standalone prompt regeneration invalidates old image tasks and reschedules a missing portrait', async (t) => {
  const session = await createSession({ title: '重新生成提示词', premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session?.player_character)
  await new Promise(resolve => setImmediate(resolve))
  const id = session.player_character.project_character_id
  await db.update(schema.characters).set({ finalPrompt: '旧提示词' }).where(eq(schema.characters.id, id))
  const timestamp = new Date().toISOString()
  const inserted = db.insert(schema.sysTask).values({ type: 'image', characterId: id,
    params: JSON.stringify({ characterImageRevision: 0, frameType: 'asset_reference' }), status: 'processing',
    createdAt: timestamp, updatedAt: timestamp }).run()
  const [oldTask] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(inserted.lastInsertRowid)))
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai', name: '测试配置',
    baseUrl: 'https://example.invalid', apiKey: 'test', model: '["test"]', createdAt: timestamp, updatedAt: timestamp }).run()
  t.mock.method(globalThis, 'fetch', async () => new Response('test failure', { status: 400 }))
  t.mock.method(mastra, 'getAgent', (() => ({ generate: async (_messages: unknown, options: any) => {
    await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: id, prompt: '新生成提示词' }, options)
  } })) as any)
  try {
    const response = await characterRoutes.request(`/${id}/generate-prompt`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ episode_id: session.episode_id, force: true }) })
    assert.equal(response.status, 200)
    await writeBackImageAssets(oldTask, '/static/old-result.png')
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    assert.equal(character.imageRevision, 1)
    assert.equal(character.imageUrl, null)
    assert.match(character.finalPrompt || '', /新生成提示词/)
    let replacement: typeof schema.sysTask.$inferSelect | undefined
    for (let attempt = 0; attempt < 100; attempt++) {
      const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.characterId, id))
      replacement = tasks.find(task => task.id !== oldTask.id && JSON.parse(task.params || '{}').characterImageRevision === 1)
      if (replacement?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(replacement)
    assert.match(replacement.prompt || '', /新生成提示词/)
    assert.equal(replacement.status, 'failed')
  } finally {
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('editing a prompt reschedules missing RPG portraits after the latest revision is saved', async (t) => {
  const sessions = await Promise.all(['仅提示词', '资料和提示词'].map(title => createSession({
    title, premise: '一位旅行者来到陌生的城镇并寻找失散多年的朋友。',
  })))
  await new Promise(resolve => setImmediate(resolve))
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'openai',
    name: '测试配置', baseUrl: 'https://example.invalid', apiKey: 'test', model: '["test"]',
    createdAt: timestamp, updatedAt: timestamp }).run()
  t.mock.method(globalThis, 'fetch', async () => new Response('test failure', { status: 400 }))
  try {
    for (const [index, session] of sessions.entries()) {
      assert.ok(session?.player_character)
      const id = session.player_character.project_character_id
      const [before] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
      const inserted = await db.insert(schema.sysTask).values({ type: 'image', characterId: id,
        params: JSON.stringify({ characterImageRevision: before.imageRevision, frameType: 'asset_reference' }),
        status: 'processing', createdAt: timestamp, updatedAt: timestamp })
      const [oldTask] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, Number(inserted.lastInsertRowid)))
      const response = await characterRoutes.request(`/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(index ? { appearance: '新外貌' } : {}), final_prompt: '手写新提示词' }) })
      assert.equal(response.status, 200)
      await writeBackImageAssets(oldTask, '/static/old-task.png')
      const [updated] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
      assert.equal(updated.imageUrl, null)
      let newTask: typeof schema.sysTask.$inferSelect | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.characterId, id))
        newTask = tasks.find(task => task.id !== oldTask.id && JSON.parse(task.params || '{}').characterImageRevision === updated.imageRevision)
        if (newTask?.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.ok(newTask, 'a task must be created for the latest revision')
      assert.equal(newTask.prompt, '手写新提示词')
      assert.equal(newTask.status, 'failed')
    }
  } finally {
    await db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid)))
  }
})

test('outdated character image tasks cannot overwrite a newer revision', async () => {
  const session = await createSession({ title: '图片版本', premise: '一位旅行者走进陌生城镇并发现了一个神秘的线索。' })
  assert.ok(session?.player_character)
  const id = session.player_character.project_character_id
  const timestamp = new Date().toISOString()
  const inserted = await db.insert(schema.sysTask).values({
    type: 'image', characterId: id, params: JSON.stringify({ characterImageRevision: 0 }),
    status: 'processing', createdAt: timestamp, updatedAt: timestamp,
  })
  const taskId = Number(inserted.lastInsertRowid)
  const [oldTask] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
  await updateSessionPlayerCharacter(session.id, { appearance: '新的外貌' })
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id,
    characterImageRevision: { id, revision: 0 } })
  const stalePrompt = await imagePromptTools.saveCharacterFinalPrompt.execute!({ character_id: id, prompt: '旧提示词' }, { requestContext } as any)
  assert.match(String((stalePrompt as any).error), /角色资料已更新/)
  await writeBackImageAssets(oldTask, '/static/old.png')
  let [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageRevision, 1)
  assert.equal(character.imageUrl, null)
  await writeBackImageAssets({ ...oldTask, params: JSON.stringify({ characterImageRevision: 1 }) }, '/static/new.png')
  ;[character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  assert.equal(character.imageUrl, '/static/new.png')
})

test('global character names are unique across both creation routes', async () => {
  const session = await createSession({ title: '角色重名', premise: '一位旅行者进入城镇，开始寻找一位失散多年的朋友。' })
  assert.ok(session)
  const headers = { 'content-type': 'application/json' }
  const create = async (name: string) => {
    const response = await characterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({ drama_id: session.drama_id, name }) })
    return (await response.json() as any).data.id as number
  }
  const first = await create('独特名字')
  const second = await create('独特名字')
  assert.equal((await characterRoutes.request(`/${first}/save-global`, { method: 'POST' })).status, 201)
  assert.equal((await characterRoutes.request(`/${second}/save-global`, { method: 'POST' })).status, 400)
  assert.equal((await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({ name: ' 独特名字 ' }) })).status, 400)
})

test('deleting a global character unlinks every project and allows saving again', async () => {
  const headers = { 'content-type': 'application/json' }
  const response = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '可重新保存的角色', appearance: '固定外貌', image_url: '/static/global.png',
  }) })
  const global = (await response.json() as any).data
  const sessions = await Promise.all(['第一世界', '第二世界'].map(title => createSession({
    title, premise: '一位旅人穿过山谷，来到一座陌生的边境城镇。', global_character_id: global.id,
  })))
  const [first, second] = sessions
  assert.ok(first?.player_character && second?.player_character)
  const ts = new Date().toISOString()
  const story = db.insert(schema.characters).values({ dramaId: first.drama_id, globalCharacterId: global.id,
    name: '关联剧情人物', appearance: '原有外貌', createdAt: ts, updatedAt: ts }).run()
  const storyId = Number(story.lastInsertRowid)
  db.insert(schema.episodeCharacters).values({ episodeId: first.episode_id, characterId: storyId, createdAt: ts }).run()

  assert.equal((await globalCharacterRoutes.request(`/${global.id}`, { method: 'DELETE' })).status, 200)
  const roster = (await (await globalCharacterRoutes.request('/')).json() as any).data
  assert.equal(roster.some((character: any) => character.id === global.id), false)
  for (const session of [first, second]) {
    const refreshed = await getSession(session.id)
    const playerId = session.player_character!.project_character_id
    assert.equal(refreshed?.player_character?.global_character_id, null)
    assert.equal(refreshed?.player_character?.image_url, '/static/global.png')
    assert.equal(refreshed?.assets.characters.find(character => character.id === playerId)?.global_character_id, null)
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, playerId))
    assert.equal(character.globalCharacterId, null)
    assert.equal(character.manualOverride, true)
    assert.equal(character.appearance, '固定外貌')
  }
  const episodeCharacters = (await (await episodeRoutes.request(`/${first.episode_id}/characters`)).json() as any).data
  assert.equal(episodeCharacters.find((character: any) => character.id === storyId).global_character_id, null)
  const context = buildAgentRequestContext({ episodeId: first.episode_id, dramaId: first.drama_id })
  await extractTools.saveDedupCharacters.execute!({ characters: [{ name: '关联剧情人物', appearance: '提取的新外貌' }] }, { requestContext: context } as any)
  const [storyAfter] = await db.select().from(schema.characters).where(eq(schema.characters.id, storyId))
  assert.equal(storyAfter.appearance, '原有外貌')
  assert.equal(storyAfter.manualOverride, true)

  const playerId = first.player_character.project_character_id
  const saved = await characterRoutes.request(`/${playerId}/save-global`, { method: 'POST' })
  assert.equal(saved.status, 201)
  const savedId = (await saved.json() as any).data.id
  assert.notEqual(savedId, global.id)
  const refreshed = await getSession(first.id)
  assert.equal(refreshed?.player_character?.global_character_id, savedId)
  assert.equal(refreshed?.assets.characters.find(character => character.id === playerId)?.global_character_id, savedId)
  assert.equal((await characterRoutes.request(`/${playerId}/save-global`, { method: 'POST' })).status, 200)
})

test('a global character deleted during session creation becomes a protected local copy', async (t) => {
  const response = await globalCharacterRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '创建时删除的角色', appearance: '固定外貌' }) })
  const global = (await response.json() as any).data
  const insert = db.insert.bind(db)
  let deleted = false
  t.mock.method(db, 'insert', ((table: unknown) => {
    if (table === schema.dramas && !deleted) {
      deleted = true
      db.update(schema.globalCharacters).set({ deletedAt: new Date().toISOString() }).where(eq(schema.globalCharacters.id, global.id)).run()
    }
    return (insert as any)(table)
  }) as typeof db.insert)
  const session = await createSession({ title: '并发删除', premise: '一位旅人穿过山谷，来到一座陌生的边境城镇。', global_character_id: global.id })
  assert.equal(deleted, true)
  assert.ok(session?.player_character)
  assert.equal(session.player_character.global_character_id, null)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, session.player_character.project_character_id))
  assert.equal(character.globalCharacterId, null)
  assert.equal(character.manualOverride, true)
  assert.equal(character.appearance, '固定外貌')
})

test('a world keeps the global character references it started with', async () => {
  const headers = { 'content-type': 'application/json' }
  const response = await globalCharacterRoutes.request('/', { method: 'POST', headers, body: JSON.stringify({
    name: '快照角色', image_url: '/static/first.png', reference_images: JSON.stringify(['/static/detail.png']),
  }) })
  const global = (await response.json() as any).data
  const session = await createSession({ title: '角色快照', premise: '一位旅人穿过山谷，来到一座陌生的边境城镇。', global_character_id: global.id })
  assert.ok(session?.player_character)
  await globalCharacterRoutes.request(`/${global.id}`, { method: 'PUT', headers, body: JSON.stringify({ image_url: '/static/second.png' }) })
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, session.player_character.project_character_id))
  assert.deepEqual(parseCharacterReferenceImages(character.referenceImages), ['/static/first.png', '/static/detail.png'])
})

test('extraction fills empty manual fields and reads its own script snapshot', async () => {
  const session = await createSession({ title: '剧情提取', premise: '一位旅人来到陌生的城镇并寻找失散多年的朋友。' })
  assert.ok(session)
  const response = await characterRoutes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ drama_id: session.drama_id, name: '手动角色', role: '医师' }) })
  const characterId = (await response.json() as any).data.id
  await db.update(schema.episodes).set({ scriptContent: '后续剧情' }).where(eq(schema.episodes.id, session.episode_id))
  const requestContext = buildAgentRequestContext({ episodeId: session.episode_id, dramaId: session.drama_id, extractionScript: '原始剧情' })
  const script = await extractTools.readScriptForExtraction.execute!({}, { requestContext } as any)
  assert.equal((script as any).script, '原始剧情')
  await extractTools.saveDedupCharacters.execute!({ characters: [{ name: '手动角色', role: '商人', appearance: '短发', background: '来自北方' }] }, { requestContext } as any)
  const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
  assert.equal(character.role, '医师')
  assert.equal(character.appearance, '短发')
  assert.equal(character.background, '来自北方')
})
