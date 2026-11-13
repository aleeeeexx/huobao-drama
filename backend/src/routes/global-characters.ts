import { desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, getInsertId, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { generateGlobalCharacterDraft } from '../services/global-character.js'
import { ASSET_REFERENCE_FRAME, CHARACTER_IMAGE_SIZE, characterImagePrompt } from '../services/asset-images.js'
import { generateGlobalCharacterFinalPrompt } from '../services/final-prompt.js'
import { getActiveStylePreset } from '../services/style-preset.js'
import { generateImage } from '../services/generation.js'
import { parseCharacterReferenceImages, snapshotCharacterReferences, snapshotGlobalCharacterImage } from '../services/character-image.js'

const app = new Hono()
const imageSubmissions = new Set<number>()
const editableFields = {
  name: 'name',
  role: 'role',
  appearance: 'appearance',
  physique: 'physique',
  default_personality: 'defaultPersonality',
  default_values: 'defaultValues',
  default_speech: 'defaultSpeech',
  default_habits: 'defaultHabits',
  default_desires: 'defaultDesires',
  default_fears: 'defaultFears',
  default_relationships: 'defaultRelationships',
  default_abilities: 'defaultAbilities',
  default_background: 'defaultBackground',
  default_styling: 'defaultStyling',
  image_url: 'imageUrl',
  reference_images: 'referenceImages',
} as const
const fieldLimits = {
  name: 80,
  role: 120,
  appearance: 2000,
  physique: 2000,
  default_personality: 2000,
  default_values: 2000,
  default_speech: 2000,
  default_habits: 2000,
  default_desires: 2000,
  default_fears: 2000,
  default_relationships: 2000,
  default_abilities: 2000,
  default_background: 2000,
  default_styling: 2000,
} as const

function textField(input: keyof typeof fieldLimits, value: unknown) {
  const text = String(value || '')
  return (input === 'name' ? text.trim() : text).slice(0, fieldLimits[input])
}

app.get('/', async (c) => {
  const rows = await db.select().from(schema.globalCharacters)
    .where(isNull(schema.globalCharacters.deletedAt))
    .orderBy(schema.globalCharacters.name)
  return success(c, toSnakeCaseArray(rows))
})

app.post('/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await generateGlobalCharacterDraft(body.concept))
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '角色草稿生成失败')
  }
})

app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id <= 0) return badRequest(c, '角色编号无效')
  if (imageSubmissions.has(id)) return badRequest(c, '该角色正在提交图片任务，请稍候')
  imageSubmissions.add(id)
  try {
    const body = await c.req.json().catch(() => ({}))
    const [character] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id))
    if (!character || character.deletedAt) return notFound(c, '全局角色不存在')
    const style = typeof body.style === 'string' ? body.style.trim() : ''
    if (!style) return badRequest(c, '请选择角色参考图的视觉风格')
    const preset = await getActiveStylePreset(style)
    if (!preset?.prompt.trim()) return badRequest(c, '所选视觉风格不存在或已停用，请重新选择')

    const imageTasks = await db.select({ params: schema.sysTask.params, status: schema.sysTask.status })
      .from(schema.sysTask).where(eq(schema.sysTask.type, 'image')).orderBy(desc(schema.sysTask.id))
    const latestTask = imageTasks.find(task => {
      try { return JSON.parse(task.params || '{}').globalCharacterId === id } catch { return false }
    })
    if (latestTask?.status === 'processing') return badRequest(c, '该角色已有图片任务正在生成，请稍候')

    const source = snapshotGlobalCharacterImage(character)
    const stylePrompt = preset.prompt
    const finalPrompt = await generateGlobalCharacterFinalPrompt(character, stylePrompt, {
      model: body.text_model, configId: body.text_config_id,
    })
    const [current] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id))
    if (!current || current.deletedAt) return notFound(c, '全局角色不存在')
    if (JSON.stringify(snapshotGlobalCharacterImage(current)) !== JSON.stringify(source)) {
      return badRequest(c, '角色资料或参考图已更新，请重新生成图片')
    }
    const imageGenerationId = await generateImage({
      globalCharacterId: id,
      globalCharacterImageSource: source,
      globalCharacterImageStyle: { value: preset.value, prompt: stylePrompt },
      prompt: finalPrompt || characterImagePrompt({
        name: character.name,
        appearance: character.appearance,
        physique: character.physique,
        styling: character.defaultStyling,
      }, stylePrompt),
      size: CHARACTER_IMAGE_SIZE,
      frameType: ASSET_REFERENCE_FRAME,
      model: body.model,
      configId: body.config_id,
      referenceImages: parseCharacterReferenceImages(snapshotCharacterReferences(character.imageUrl, character.referenceImages)),
    })
    return success(c, { image_generation_id: imageGenerationId })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '角色图生成失败')
  } finally {
    imageSubmissions.delete(id)
  }
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const name = textField('name', body.name)
  if (!name) return badRequest(c, '角色名称必填')
  const duplicate = db.select().from(schema.globalCharacters)
    .where(isNull(schema.globalCharacters.deletedAt)).all()
  if (duplicate.some(row => row.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return badRequest(c, '全局角色库中已存在同名角色')
  }
  const ts = now()
  const res = db.insert(schema.globalCharacters).values({
    name,
    role: textField('role', body.role),
    appearance: textField('appearance', body.appearance),
    physique: textField('physique', body.physique),
    defaultPersonality: textField('default_personality', body.default_personality),
    defaultValues: textField('default_values', body.default_values),
    defaultSpeech: textField('default_speech', body.default_speech),
    defaultHabits: textField('default_habits', body.default_habits),
    defaultDesires: textField('default_desires', body.default_desires),
    defaultFears: textField('default_fears', body.default_fears),
    defaultRelationships: textField('default_relationships', body.default_relationships),
    defaultAbilities: textField('default_abilities', body.default_abilities),
    defaultBackground: textField('default_background', body.default_background),
    defaultStyling: textField('default_styling', body.default_styling),
    imageUrl: body.image_url || null,
    referenceImages: body.reference_images || null,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [row] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, getInsertId(res)))
  return created(c, toSnakeCase(row))
})

app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [current] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id))
  if (!current || current.deletedAt) return notFound(c, '全局角色不存在')
  const updates: Record<string, unknown> = { updatedAt: now() }
  for (const [input, column] of Object.entries(editableFields)) {
    if (input in body) {
      updates[column] = input in fieldLimits
        ? textField(input as keyof typeof fieldLimits, body[input])
        : body[input]
    }
  }
  if ('name' in updates && !updates.name) return badRequest(c, '角色名称必填')
  if (typeof updates.name === 'string' && updates.name.toLocaleLowerCase() !== current.name.trim().toLocaleLowerCase()) {
    const updatedName = updates.name.toLocaleLowerCase()
    const rows = await db.select().from(schema.globalCharacters).where(isNull(schema.globalCharacters.deletedAt))
    if (rows.some(row => row.id !== id && row.name.trim().toLocaleLowerCase() === updatedName)) {
      return badRequest(c, '全局角色库中已存在同名角色')
    }
  }
  await db.update(schema.globalCharacters).set(updates).where(eq(schema.globalCharacters.id, id))
  const [row] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id))
  return success(c, toSnakeCase(row))
})

app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const deleted = db.transaction((tx) => {
    const current = tx.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id)).get()
    if (!current || current.deletedAt) return false
    const ts = now()
    tx.update(schema.globalCharacters).set({ deletedAt: ts, updatedAt: ts }).where(eq(schema.globalCharacters.id, id)).run()
    tx.update(schema.characters).set({ globalCharacterId: null, manualOverride: true, updatedAt: ts })
      .where(eq(schema.characters.globalCharacterId, id)).run()
    return true
  })
  if (!deleted) return notFound(c, '全局角色不存在')
  return success(c)
})

export default app
