import { Hono } from 'hono'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { enqueueAssetReferenceImage, scheduleEpisodeAssetImages } from '../services/asset-images.js'
import { parseCharacterReferenceImages, snapshotCharacterReferences } from '../services/character-image.js'
import { ensureCharacterFinalPrompt } from '../services/final-prompt.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { updateSessionPlayerCharacter } from '../services/rpg/engine.js'
import { NOVEL_PLAY_KIND } from '../services/rpg/play-kind.js'

const app = new Hono()

// POST /characters — 手动新增角色（传入 episode_id 时关联到该集）
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.drama_id) return badRequest(c, 'drama_id 必填')
  if (!body.name?.trim()) return badRequest(c, '名称必填')
  const ts = now()
  const res = await db.insert(schema.characters).values({
    name: body.name.trim(),
    manualOverride: true,
    role: body.role || '',
    description: body.description || '',
    background: body.background || '',
    appearance: body.appearance || '',
    physique: body.physique || '',
    styling: body.styling || '',
    personality: body.personality || '',
    dramaId: body.drama_id,
    createdAt: ts,
    updatedAt: ts,
  })
  const charId = getInsertId(res)
  if (body.episode_id) {
    const existing = await db.select().from(schema.episodeCharacters)
      .where(and(eq(schema.episodeCharacters.episodeId, Number(body.episode_id)), eq(schema.episodeCharacters.characterId, charId)))
    if (!existing.length) {
      await db.insert(schema.episodeCharacters).values({ episodeId: Number(body.episode_id), characterId: charId, createdAt: ts })
    }
  }
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, charId))
  return created(c, toSnakeCase(row))
})

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'role', 'description', 'background', 'appearance', 'physique', 'styling', 'personality', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  let reschedule: { dramaId: number; episodeIds: number[] } | null = null
  if (['name', 'role', 'description', 'background', 'appearance', 'physique', 'styling', 'personality']
    .some(key => key in body || key.replace(/[A-Z]/g, m => '_' + m.toLowerCase()) in body)) {
    updates.manualOverride = true
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (character) {
      const sessions = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.dramaId, character.dramaId))
      const session = sessions.find(row => {
        try { return JSON.parse(row.playerCharacter || 'null')?.project_character_id === id } catch { return false }
      })
      if (session) {
        try {
          await updateSessionPlayerCharacter(session.id, body)
          for (const key of ['name', 'role', 'description', 'background', 'appearance', 'physique', 'styling', 'personality', 'manualOverride']) {
            delete updates[key]
          }
        } catch (error) {
          return badRequest(c, error instanceof Error ? error.message : '角色资料保存失败')
        }
      } else if (sessions.length && ['name', 'role', 'description', 'background', 'appearance', 'physique', 'styling', 'personality']
        .some(key => key in updates && (updates[key] || '') !== ((character as Record<string, unknown>)[key] || ''))) {
        updates.referenceImages = snapshotCharacterReferences(character.imageUrl || character.localPath, character.referenceImages)
        updates.finalPrompt = sql`CASE WHEN ${schema.characters.finalPromptAuto} = 1 THEN NULL ELSE ${schema.characters.finalPrompt} END`
        if (!('imageUrl' in updates)) updates.imageUrl = null
        if (!('localPath' in updates)) updates.localPath = null
        updates.imageRevision = sql`${schema.characters.imageRevision} + 1`
        const links = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, id))
        const linkedEpisodes = new Set(links.map(link => link.episodeId))
        reschedule = { dramaId: character.dramaId, episodeIds: sessions.map(row => row.episodeId).filter(episodeId => linkedEpisodes.has(episodeId)) }
      }
    }
  }
  // 手动编辑最终提示词时以传入值为准。
  if (body.final_prompt !== undefined) updates.finalPrompt = body.final_prompt || null
  else if (body.finalPrompt !== undefined) updates.finalPrompt = body.finalPrompt || null
  if (body.final_prompt !== undefined || body.finalPrompt !== undefined) updates.finalPromptAuto = false
  if ('imageUrl' in updates || 'localPath' in updates) updates.imageAuto = false
  if ('imageUrl' in updates || 'localPath' in updates || body.final_prompt !== undefined || body.finalPrompt !== undefined) {
    updates.imageRevision = sql`${schema.characters.imageRevision} + 1`
  }
  await db.update(schema.characters).set(updates).where(eq(schema.characters.id, id))
  if (!reschedule && (body.final_prompt !== undefined || body.finalPrompt !== undefined)) {
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (character) {
      const sessions = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.dramaId, character.dramaId))
      const links = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.characterId, id))
      const linkedEpisodes = new Set(links.map(link => link.episodeId))
      reschedule = { dramaId: character.dramaId, episodeIds: sessions.map(row => row.episodeId).filter(episodeId => linkedEpisodes.has(episodeId)) }
    }
  }
  if (reschedule) for (const episodeId of reschedule.episodeIds) scheduleEpisodeAssetImages(reschedule.dramaId, episodeId)
  const [updated] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  return success(c, updated ? toSnakeCase(updated) : null)
})

// POST /characters/:id/save-global — copy a project character into the global character library.
app.post('/:id/save-global', async (c) => {
  const id = Number(c.req.param('id'))
  const result = db.transaction((tx) => {
    const character = tx.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!character || character.deletedAt) return { error: '角色不存在' } as const
    if (character.globalCharacterId) {
      const existing = tx.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, character.globalCharacterId)).get()
      if (existing && !existing.deletedAt) return { saved: existing, created: false } as const
    }
    const existingNames = tx.select().from(schema.globalCharacters).where(isNull(schema.globalCharacters.deletedAt)).all()
    if (existingNames.some(row => row.name.trim().toLocaleLowerCase() === character.name.trim().toLocaleLowerCase())) {
      return { error: '全局角色库中已存在同名角色' } as const
    }
    const ts = now()
    const res = tx.insert(schema.globalCharacters).values({
      name: character.name,
      role: character.role,
      appearance: character.appearance || character.description,
      physique: character.physique,
      defaultPersonality: character.personality,
      defaultStyling: character.styling,
      imageUrl: character.imageUrl || character.localPath || parseCharacterReferenceImages(character.referenceImages)[0] || null,
      referenceImages: character.referenceImages,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const globalId = getInsertId(res)
    tx.update(schema.characters).set({ globalCharacterId: globalId, updatedAt: ts }).where(eq(schema.characters.id, id)).run()
    const saved = tx.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, globalId)).get()!
    return { saved, created: true } as const
  })
  if ('error' in result) return badRequest(c, result.error)
  return result.created ? created(c, toSnakeCase(result.saved)) : success(c, toSnakeCase(result.saved))
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const deleted = db.transaction((tx) => {
    const character = tx.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    if (!character || character.deletedAt) return true
    const sessions = tx.select({ playerCharacter: schema.rpgSessions.playerCharacter }).from(schema.rpgSessions)
      .where(and(eq(schema.rpgSessions.dramaId, character.dramaId), ne(schema.rpgSessions.playKind, NOVEL_PLAY_KIND))).all()
    const isPlayer = sessions.some((session) => {
      try { return JSON.parse(session.playerCharacter || 'null')?.project_character_id === id } catch { return false }
    })
    if (isPlayer) return false
    tx.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
    return true
  })
  if (!deleted) return badRequest(c, '本局主角无法删除，请在游戏中编辑')
  return success(c)
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  try {
    const enqueued = await enqueueAssetReferenceImage('character', id, {
      episodeId: ep.id,
      model: body.model,
      configId: body.config_id ?? ep.imageConfigId ?? undefined,
      textModel: body.text_model,
      textConfigId: body.text_config_id ?? undefined,
      skipIfPresent: false,
    })
    if (!enqueued.taskId) return badRequest(c, '图片任务没有提交')
    return success(c, { image_generation_id: enqueued.taskId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/:id/generate-prompt — 独立生成/重新生成三视图最终提示词（不生图）
app.post('/:id/generate-prompt', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!char) return badRequest(c, '角色不存在')
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')

  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')

  logTaskStart('FinalPrompt', 'character-generate', { characterId: id, episodeId: ep.id, force: !!body.force })
  const finalPrompt = await ensureCharacterFinalPrompt(char, ep.id, !!body.force, { model: body.text_model, configId: body.text_config_id ?? undefined })
  if (!finalPrompt) {
    logTaskError('FinalPrompt', 'character-generate', { characterId: id, error: 'agent returned empty prompt' })
    return badRequest(c, '最终提示词生成失败，请重试')
  }
  const sessions = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.dramaId, char.dramaId))
  if (sessions.some(session => session.episodeId === ep.id)) scheduleEpisodeAssetImages(char.dramaId, ep.id)
  logTaskSuccess('FinalPrompt', 'character-generate', { characterId: id })
  return success(c, { final_prompt: finalPrompt })
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id 必填')
  const [ep] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id)))
  if (!ep) return badRequest(c, '剧集不存在')
  const results: number[] = []
  for (const cid of ids) {
    const [char] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid))
    if (!char) continue
    try {
      const enqueued = await enqueueAssetReferenceImage('character', cid, {
        episodeId: ep.id,
        model: body.model,
        configId: body.config_id ?? ep.imageConfigId ?? undefined,
        textModel: body.text_model,
        textConfigId: body.text_config_id ?? undefined,
        skipIfPresent: false,
      })
      if (enqueued.taskId) results.push(enqueued.taskId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
