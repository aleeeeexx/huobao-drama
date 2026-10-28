/**
 * 角色定妆、场景空镜、道具白底图。
 * 制作台按钮和织界补缺走同一条：最终提示词 → generateImage，已有 imageUrl 的不重画。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { ensureCharacterFinalPrompt, ensurePropFinalPrompt, ensureSceneFinalPrompt } from './final-prompt.js'
import { generateImage } from './generation.js'
import { getDramaStylePrompt } from './style-preset.js'
import { ASSET_REFERENCE_FRAME, decideAssetEnqueue, isAssetReferenceTask } from './rpg/references.js'

export const CHARACTER_IMAGE_SIZE = '1920x1080'
export const PROP_IMAGE_SIZE = '1024x1024'
export { ASSET_REFERENCE_FRAME }

type AssetKind = 'character' | 'scene' | 'prop'
type AssetRow = {
  id: number
  dramaId: number
  finalPrompt: string | null
  imageUrl: string | null
  localPath: string | null
}

export interface AssetImageOptions {
  episodeId: number
  model?: string
  configId?: number
  textModel?: string
  textConfigId?: number
  /** 已有参考图则直接复用。制作台「生成」按钮传 false。 */
  skipIfPresent?: boolean
  /** 上一张参考图失败后是否再提交。回合后台补图不重试，剧情图/影像会再试一次。 */
  retryFailed?: boolean
  /** 未显式指定 configId 时，用本集锁定的图片配置。 */
  resolveConfigFromEpisode?: boolean
}

export interface EnqueuedAssetImage {
  taskId: number | null
  imageUrl: string | null
  finalPrompt: string
}

const pendingAssetImages = new Map<string, Promise<EnqueuedAssetImage>>()
const episodeAssetJobs = new Map<number, Promise<void>>()
const episodeAssetRerun = new Set<number>()

export function characterImagePrompt(char: { name: string; appearance?: string | null; description?: string | null; styling?: string | null }, stylePrompt = '') {
  return [
    stylePrompt || '',
    char.name,
    char.appearance || char.description || '人物立绘',
    char.styling || '',
    '16:9 横版角色定妆照',
    '半身角色海报构图',
    '正面',
    '高质量',
    '白色背景',
  ].filter(Boolean).join(', ')
}

export function sceneImagePrompt(scene: { location: string; time?: string | null; prompt?: string | null; lighting?: string | null }, stylePrompt = '') {
  return [
    stylePrompt || '',
    scene.location,
    scene.time || '',
    scene.prompt || '高质量场景',
    scene.lighting || '电影感光影',
    '画面中没有任何人物，空场景，只有场景本身',
  ].filter(Boolean).join(', ')
}

export function propImagePrompt(prop: { name: string; description?: string | null }, stylePrompt = '') {
  return [
    stylePrompt || '',
    `single product photo of ${prop.name}`,
    prop.description || '',
    'isolated on a pure white background',
    'no other objects, no people, no scenery',
    'soft even studio lighting',
    'high detail',
    'no text, no watermark',
  ].filter(Boolean).join(', ')
}

/** 开场和每回合提取之后调用。不 await：叙事先返回，缺图的资产在后台补定妆/场景图/道具图。 */
export function scheduleEpisodeAssetImages(dramaId: number, episodeId: number) {
  if (episodeAssetJobs.has(episodeId)) {
    episodeAssetRerun.add(episodeId)
    return
  }
  const job = (async () => {
    do {
      episodeAssetRerun.delete(episodeId)
      try {
        await ensureMissingEpisodeAssets(dramaId, episodeId)
      } catch (error) {
        logTaskError('AssetImage', 'episode-ensure', {
          dramaId,
          episodeId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } while (episodeAssetRerun.has(episodeId))
  })().finally(() => {
    episodeAssetJobs.delete(episodeId)
  })
  episodeAssetJobs.set(episodeId, job)
}

export async function enqueueAssetReferenceImage(
  kind: AssetKind,
  id: number,
  options: AssetImageOptions,
): Promise<EnqueuedAssetImage> {
  const row = await loadAsset(kind, id)
  if (!row) throw new Error(missingAssetMessage(kind))
  const imageUrl = storedImage(row)
  const latest = options.skipIfPresent ? await latestAssetTask(kind, id) : null
  const decision = decideAssetEnqueue({
    hasImage: !!imageUrl,
    latestStatus: taskStatus(latest?.status),
    skipIfPresent: !!options.skipIfPresent,
    retryFailed: !!options.retryFailed,
  })
  if (decision === 'use-existing') {
    return { taskId: null, imageUrl, finalPrompt: row.finalPrompt || '' }
  }
  if (decision === 'reuse-task') {
    return { taskId: latest?.id ?? null, imageUrl: null, finalPrompt: row.finalPrompt || '' }
  }
  if (decision === 'skip-failed') {
    return { taskId: null, imageUrl: null, finalPrompt: row.finalPrompt || '' }
  }
  if (options.skipIfPresent) {
    return coalesceAssetImage(`${kind}:${id}`, () => submitAssetImage(kind, id, options))
  }
  return submitAssetImage(kind, id, options)
}

export async function resolveAssetReferenceImage(
  kind: AssetKind,
  id: number,
  options: AssetImageOptions & { waitUntil?: number },
): Promise<EnqueuedAssetImage> {
  try {
    const enqueued = await enqueueAssetReferenceImage(kind, id, options)
    if (enqueued.imageUrl || !enqueued.taskId || !options.waitUntil) return enqueued
    const imageUrl = await waitForAssetImage(kind, id, enqueued.taskId, options.waitUntil)
    return { ...enqueued, imageUrl }
  } catch (error) {
    logTaskError('AssetImage', 'resolve', {
      kind,
      id,
      error: error instanceof Error ? error.message : String(error),
    })
    return { taskId: null, imageUrl: null, finalPrompt: '' }
  }
}

export async function waitForAssetImage(
  kind: AssetKind,
  id: number,
  taskId: number,
  deadline: number,
): Promise<string | null> {
  while (true) {
    const row = await loadAsset(kind, id)
    const imageUrl = row ? storedImage(row) : null
    if (imageUrl) return imageUrl
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId))
    if (!task || task.status === 'failed') return null
    if (task.status === 'completed') return task.localPath || task.resultUrl || null
    if (Date.now() >= deadline) {
      logTaskWarn('AssetImage', 'reference-wait-timeout', { kind, id, taskId })
      return null
    }
    const delay = Math.min(2_000, deadline - Date.now())
    if (delay <= 0) return null
    await sleep(delay)
  }
}

async function ensureMissingEpisodeAssets(dramaId: number, episodeId: number) {
  const assets = await loadEpisodeAssetIds(dramaId, episodeId)
  const options: AssetImageOptions = {
    episodeId,
    skipIfPresent: true,
    retryFailed: false,
    resolveConfigFromEpisode: true,
  }
  for (const id of assets.characterIds) {
    await enqueueQuietly('character', id, options)
  }
  for (const id of assets.sceneIds) {
    await enqueueQuietly('scene', id, options)
  }
  for (const id of assets.propIds) {
    await enqueueQuietly('prop', id, options)
  }
}

async function enqueueQuietly(kind: AssetKind, id: number, options: AssetImageOptions) {
  try {
    await enqueueAssetReferenceImage(kind, id, options)
  } catch (error) {
    logTaskError('AssetImage', 'episode-item', {
      kind,
      id,
      episodeId: options.episodeId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function submitAssetImage(kind: AssetKind, id: number, options: AssetImageOptions): Promise<EnqueuedAssetImage> {
  const row = await loadAsset(kind, id)
  if (!row) throw new Error(missingAssetMessage(kind))
  if (options.skipIfPresent) {
    const imageUrl = storedImage(row)
    if (imageUrl) return { taskId: null, imageUrl, finalPrompt: row.finalPrompt || '' }
    const latest = await latestAssetTask(kind, id)
    if (latest?.status === 'processing') {
      return { taskId: latest.id, imageUrl: null, finalPrompt: row.finalPrompt || '' }
    }
  }
  const configId = await resolveConfigId(options)
  const textOpts = { model: options.textModel, configId: options.textConfigId }
  const stylePrompt = await getDramaStylePrompt(row.dramaId)
  if (kind === 'character') {
    const char = await mustCharacter(id)
    const finalPrompt = await ensureCharacterFinalPrompt(char, options.episodeId, false, textOpts)
    const prompt = finalPrompt || characterImagePrompt(char, stylePrompt)
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: options.episodeId, dramaId: char.dramaId })
    const taskId = await generateImage({
      characterId: id,
      dramaId: char.dramaId,
      prompt,
      model: options.model || undefined,
      size: CHARACTER_IMAGE_SIZE,
      configId,
      frameType: ASSET_REFERENCE_FRAME,
    })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: taskId })
    return { taskId, imageUrl: null, finalPrompt }
  }
  if (kind === 'scene') {
    const scene = await mustScene(id)
    const finalPrompt = await ensureSceneFinalPrompt(scene, options.episodeId, false, textOpts)
    const prompt = finalPrompt || sceneImagePrompt(scene, stylePrompt)
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: options.episodeId, dramaId: scene.dramaId, location: scene.location })
    await db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id))
    try {
      const taskId = await generateImage({
        sceneId: id,
        dramaId: scene.dramaId,
        prompt,
        model: options.model || undefined,
        configId,
        frameType: ASSET_REFERENCE_FRAME,
      })
      logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: taskId })
      return { taskId, imageUrl: null, finalPrompt }
    } catch (error) {
      logTaskError('SceneImage', 'generate', { sceneId: id, error: error instanceof Error ? error.message : String(error) })
      await db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id))
      throw error
    }
  }
  const prop = await mustProp(id)
  const finalPrompt = await ensurePropFinalPrompt(prop, options.episodeId, false, textOpts)
  const prompt = finalPrompt || propImagePrompt(prop, stylePrompt)
  logTaskStart('PropImage', 'generate', { propId: id, episodeId: options.episodeId, dramaId: prop.dramaId })
  const taskId = await generateImage({
    propId: id,
    dramaId: prop.dramaId,
    prompt,
    model: options.model || undefined,
    size: PROP_IMAGE_SIZE,
    configId,
    frameType: ASSET_REFERENCE_FRAME,
  })
  logTaskSuccess('PropImage', 'generate', { propId: id, generationId: taskId })
  return { taskId, imageUrl: null, finalPrompt }
}

function coalesceAssetImage(key: string, job: () => Promise<EnqueuedAssetImage>): Promise<EnqueuedAssetImage> {
  const existing = pendingAssetImages.get(key)
  if (existing) return existing
  const promise = job().finally(() => {
    if (pendingAssetImages.get(key) === promise) pendingAssetImages.delete(key)
  })
  pendingAssetImages.set(key, promise)
  return promise
}

async function resolveConfigId(options: AssetImageOptions) {
  if (options.configId) return options.configId
  if (!options.resolveConfigFromEpisode) return undefined
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, options.episodeId))
  return episode?.imageConfigId ?? undefined
}

async function loadEpisodeAssetIds(dramaId: number, episodeId: number) {
  const characterLinks = await db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId))
  const sceneLinks = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  const propLinks = await db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId))
  const characterIds = new Set(characterLinks.map(link => link.characterId))
  const sceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const propIds = new Set(propLinks.map(link => link.propId))
  const characters = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)))
    .filter(item => characterIds.has(item.id) && !item.deletedAt)
  const scenes = (await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)))
    .filter(item => sceneIds.has(item.id) && !item.deletedAt)
  const props = (await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId)))
    .filter(item => propIds.has(item.id) && !item.deletedAt)
  return {
    characterIds: characters.map(item => item.id),
    sceneIds: scenes.map(item => item.id),
    propIds: props.map(item => item.id),
  }
}

async function latestAssetTask(kind: AssetKind, id: number) {
  const column = kind === 'character'
    ? schema.sysTask.characterId
    : kind === 'scene'
      ? schema.sysTask.sceneId
      : schema.sysTask.propId
  const rows = await db.select().from(schema.sysTask)
    .where(and(eq(schema.sysTask.type, 'image'), eq(column, id)))
    .orderBy(desc(schema.sysTask.id))
    .limit(12)
  return rows.find(row => isAssetReferenceTask({
    frameType: readFrameType(row.params),
    prompt: row.prompt,
    storyboardId: row.storyboardId,
    characterId: row.characterId,
    sceneId: row.sceneId,
    propId: row.propId,
  })) || null
}

function taskStatus(status: string | null | undefined): 'processing' | 'completed' | 'failed' | null {
  if (status === 'processing' || status === 'completed' || status === 'failed') return status
  return null
}

function readFrameType(params: string | null | undefined) {
  if (!params) return null
  try {
    const parsed = JSON.parse(params) as { frameType?: unknown }
    return typeof parsed.frameType === 'string' ? parsed.frameType : null
  } catch {
    return null
  }
}

function storedImage(row: { imageUrl?: string | null; localPath?: string | null }) {
  const image = (row.imageUrl || '').trim()
  if (image) return image
  const local = (row.localPath || '').trim()
  return local || null
}

async function loadAsset(kind: AssetKind, id: number): Promise<AssetRow | null> {
  if (kind === 'character') {
    const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
    if (!row || row.deletedAt) return null
    return row
  }
  if (kind === 'scene') {
    const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
    if (!row || row.deletedAt) return null
    return row
  }
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!row || row.deletedAt) return null
  return row
}

async function mustCharacter(id: number) {
  const [row] = await db.select().from(schema.characters).where(eq(schema.characters.id, id))
  if (!row || row.deletedAt) throw new Error('角色不存在')
  return row
}

async function mustScene(id: number) {
  const [row] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, id))
  if (!row || row.deletedAt) throw new Error('场景不存在')
  return row
}

async function mustProp(id: number) {
  const [row] = await db.select().from(schema.props).where(eq(schema.props.id, id))
  if (!row || row.deletedAt) throw new Error('道具不存在')
  return row
}

function missingAssetMessage(kind: AssetKind) {
  if (kind === 'character') return '角色不存在'
  if (kind === 'scene') return '场景不存在'
  return '道具不存在'
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
