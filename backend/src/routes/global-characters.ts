import { eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, getInsertId, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'
import { generateGlobalCharacterDraft } from '../services/global-character.js'

const app = new Hono()
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
