/**
 * 幻书对局编排。
 * 玩家看到的章节走幻书设定、本章计划和正文续写。
 * 短剧剧本是下一步：script_rewriter 按制作台原句把原稿改成剧本。
 * extractor 同步资产，插画用 prompt_generator 的场景提示词，
 * 影像用 storyboard_breaker 追加本幕分镜，再由 prompt_generator 写视频提示词。
 */
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { generateImage, generateVideo } from '../generation.js'
import { EXTRACT_TARGETS, runExtraction } from '../extraction.js'
import { getDramaStylePrompt, prefixVideoStyle } from '../style-preset.js'
import { ensureSceneFinalPrompt } from '../final-prompt.js'
import { resolveAssetReferenceImage, scheduleEpisodeAssetImages } from '../asset-images.js'
import { snapshotCharacterReferences } from '../character-image.js'
import {
  applyReferenceMarkers,
  buildStillReferences,
  PLAY_STILL_REFERENCE_LIMIT,
  prioritizeStillReferences,
  STILL_REFERENCE_LIMIT,
  PLAY_REFERENCE_WAIT_MS,
  PLAY_STILL_FRAME,
  reuseExistingStill,
  selectPlayCharacters,
  selectPlayProps,
  stillPromptCharacters,
  VIDEO_REFERENCE_LIMIT,
} from './references.js'
import { videoModelLabel, writeStoryboardVideoPrompt } from '../video-prompts.js'
import { runStudioAgent } from '../agent-runner.js'
import { completeNovelPrompt } from '../novel/complete.js'
import {
  createNovelProject,
  exportNovelToText,
  NOVEL_MAX_TOKENS,
  produceNovelChapter,
  settleNovelProject,
  type NovelProject,
} from '../novel/generator.js'
import { LIVE_ACTION_CINEMATIC_STYLE } from '../live-action-cinematic.js'
import { now } from '../../utils/response.js'
import { PRESET_WORLDS, type WorldSeed } from './worlds.js'
import { fallbackWorldPlayerCharacterDraft, generateWorldPlayerCharacterDraft } from '../global-character.js'
import { NOVEL_PLAY_KIND, RPG_PLAY_KIND } from './play-kind.js'
import {
  assembleStillPrompt,
  appendTurnScreenplay,
  buildPlayChoicesPrompt,
  buildPlayStoryboardMessage,
  currentTurnScreenplay,
  describeAction,
  emptyWorldState,
  formatWorldCharacterGuidance,
  formatScreenplayScene,
  lastScreenplayLocation,
  projectWorldState,
  pickSessionTurn,
  publicAssetPath,
  resolvePlayerAction,
  PLAY_NOVEL_CHAPTER_CHARS,
  resolvePlayChoices,
  sceneIdFromScreenplay,
  serializePlayAssets,
  stripPipelineMeta,
  visibleNarrative,
  type ResolvedAction,
  type RpgChoice,
  type RpgWorldState,
} from './turn.js'
import {
  adaptPlayerCharacter as adaptPlayerCharacterResponse,
  fallbackPlayerCharacter,
  normalizePlayerCharacterField,
  withPlayerCharacterGuidance,
  type PlayerCharacterSnapshot,
} from './player-character.js'

const actingSessions = new Set<number>()
const assetSyncJobs = new Map<number, Promise<void>>()

export async function ensurePresetWorlds() {
  const ts = now()
  for (const world of PRESET_WORLDS) {
    const [existing] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.slug, world.slug))
    if (existing) {
      if (existing.isPreset && existing.style !== world.style) {
        await db.update(schema.rpgWorlds).set({ style: world.style, updatedAt: ts }).where(eq(schema.rpgWorlds.id, existing.id))
      }
      continue
    }
    await db.insert(schema.rpgWorlds).values({
      slug: world.slug,
      title: world.title,
      tagline: world.tagline,
      premise: world.premise,
      genre: world.genre,
      style: world.style,
      isPreset: true,
      createdAt: ts,
      updatedAt: ts,
    })
  }
}

export async function listWorlds() {
  await ensurePresetWorlds()
  const rows = await db.select().from(schema.rpgWorlds).orderBy(asc(schema.rpgWorlds.id))
  return rows.filter(row => row.isPreset).map(serializeWorld)
}

export async function listSessions() {
  const rows = await db.select().from(schema.rpgSessions)
    .where(ne(schema.rpgSessions.playKind, NOVEL_PLAY_KIND))
    .orderBy(desc(schema.rpgSessions.updatedAt))
    .limit(20)
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    status: row.status,
    turn_count: row.turnCount || 0,
    updated_at: row.updatedAt,
    drama_id: row.dramaId,
  }))
}

function createGlobalPlayerCharacter(
  globalCharacter: typeof schema.globalCharacters.$inferSelect,
  dramaId: number,
  episodeId: number,
): PlayerCharacterSnapshot {
  return db.transaction((tx) => {
    const current = tx.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, globalCharacter.id)).get()
    const globalId = current && !current.deletedAt ? globalCharacter.id : null
    const ts = now()
    const res = tx.insert(schema.characters).values({
      dramaId,
      globalCharacterId: globalId,
      manualOverride: !globalId,
      name: globalCharacter.name,
      role: globalCharacter.role || '主角',
      description: globalCharacter.appearance || '',
      appearance: globalCharacter.appearance || '',
      physique: globalCharacter.physique || '',
      styling: globalCharacter.defaultStyling || '',
      personality: globalCharacter.defaultPersonality || '',
      finalPrompt: null,
      imageUrl: globalCharacter.imageUrl || null,
      referenceImages: snapshotCharacterReferences(globalCharacter.imageUrl, globalCharacter.referenceImages),
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const projectCharacterId = getInsertId(res)
    tx.insert(schema.episodeCharacters).values({ episodeId, characterId: projectCharacterId, createdAt: ts }).run()
    return {
      global_character_id: globalId,
      project_character_id: projectCharacterId,
      name: globalCharacter.name,
      role: globalCharacter.role || '主角',
      appearance: globalCharacter.appearance || '',
      physique: globalCharacter.physique || '',
      default_personality: globalCharacter.defaultPersonality || '',
      default_styling: globalCharacter.defaultStyling || '',
      personality: globalCharacter.defaultPersonality || '',
      background: '',
      styling: globalCharacter.defaultStyling || '',
      image_url: globalCharacter.imageUrl || '',
      adapted: false,
    }
  })
}

async function createWorldPlayerCharacter(
  world: { title: string; genre?: string | null; premise: string },
  dramaId: number,
  episodeId: number,
): Promise<PlayerCharacterSnapshot> {
  let draft
  try {
    draft = await generateWorldPlayerCharacterDraft(world)
  } catch (error) {
    console.error('[rpg] default-player-character', error instanceof Error ? error.message : error)
    draft = fallbackWorldPlayerCharacterDraft(world)
  }
  const ts = now()
  const characterRes = await db.insert(schema.characters).values({
    dramaId,
    globalCharacterId: null,
    manualOverride: true,
    name: draft.name,
    role: draft.role || '主角',
    description: draft.appearance,
    appearance: draft.appearance,
    physique: draft.physique,
    background: draft.background,
    styling: draft.styling,
    personality: draft.personality,
    finalPrompt: null,
    imageUrl: null,
    referenceImages: null,
    createdAt: ts,
    updatedAt: ts,
  })
  const projectCharacterId = getInsertId(characterRes)
  await db.insert(schema.episodeCharacters).values({ episodeId, characterId: projectCharacterId, createdAt: ts })
  return {
    global_character_id: null,
    project_character_id: projectCharacterId,
    name: draft.name,
    role: draft.role || '主角',
    appearance: draft.appearance,
    physique: draft.physique,
    default_personality: draft.personality,
    default_styling: draft.styling,
    personality: draft.personality,
    background: draft.background,
    styling: draft.styling,
    image_url: '',
    adapted: true,
  }
}

export async function createSession(input: {
  world_id?: number
  global_character_id?: number
  title?: string
  premise?: string
  genre?: string
  tagline?: string
}) {
  await ensurePresetWorlds()
  const world = input.world_id
    ? await mustWorld(input.world_id)
    : await createCustomWorld(input)
  const globalCharacter = input.global_character_id
    ? await getGlobalCharacter(input.global_character_id)
    : null
  const ts = now()
  const state = emptyWorldState(world.premise)
  const dramaRes = await db.insert(schema.dramas).values({
    title: world.title,
    description: world.premise,
    genre: world.genre,
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    aspectRatio: '16:9',
    status: 'active',
    metadata: JSON.stringify({ source: 'rpg' }),
    createdAt: ts,
    updatedAt: ts,
  })
  const dramaId = getInsertId(dramaRes)
  const episodeRes = await db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '幻书正文',
    content: `【世界】${world.title}\n${world.premise}\n`,
    scriptContent: '',
    description: world.tagline,
    status: 'draft',
    resolution: '720p',
    createdAt: ts,
    updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)
  let playerCharacter: PlayerCharacterSnapshot | null = null
  if (globalCharacter) {
    playerCharacter = createGlobalPlayerCharacter(globalCharacter, dramaId, episodeId)
  } else {
    playerCharacter = await createWorldPlayerCharacter(world, dramaId, episodeId)
  }
  const sessionRes = await db.insert(schema.rpgSessions).values({
    worldId: world.id,
    dramaId,
    episodeId,
    title: world.title,
    status: 'active',
    playKind: RPG_PLAY_KIND,
    worldState: JSON.stringify(state),
    playerCharacter: playerCharacter ? JSON.stringify(playerCharacter) : null,
    turnCount: 0,
    createdAt: ts,
    updatedAt: ts,
  })
  const sessionId = getInsertId(sessionRes)
  await db.update(schema.dramas)
    .set({ metadata: JSON.stringify({ source: 'rpg', session_id: sessionId }) })
    .where(eq(schema.dramas.id, dramaId))
  scheduleEpisodeAssetImages(dramaId, episodeId)
  return getSession(sessionId)
}

export async function getSession(sessionId: number) {
  const [session] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, sessionId))
  if (!session || session.playKind === NOVEL_PLAY_KIND) return null
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, session.worldId))
  const turns = await db.select().from(schema.rpgTurns)
    .where(eq(schema.rpgTurns.sessionId, sessionId))
    .orderBy(asc(schema.rpgTurns.turnIndex))
  const refreshed = []
  for (const turn of turns) refreshed.push(await refreshTurnMedia(turn))
  const assets = await loadEpisodeAssets(session.dramaId, session.episodeId)
  const playerCharacter = parseJson<PlayerCharacterSnapshot | null>(session.playerCharacter, null)
  const playerAsset = playerCharacter
    ? assets.characters.find(character => character.id === playerCharacter.project_character_id)
    : null
  if (playerCharacter) {
    playerCharacter.global_character_id = playerAsset?.globalCharacterId || null
    playerCharacter.image_url = playerAsset
      ? serializePlayAssets({ characters: [playerAsset], scenes: [], props: [] }).characters[0].image_url || ''
      : ''
  }
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    drama_id: session.dramaId,
    episode_id: session.episodeId,
    turn_count: session.turnCount || 0,
    world: world ? serializeWorld(world) : null,
    world_state: parseJson<RpgWorldState>(session.worldState, emptyWorldState()),
    player_character: playerCharacter,
    assets: serializePlayAssets(assets),
    turns: refreshed.map(serializeTurn),
    acting: actingSessions.has(sessionId),
    asset_sync_pending: assetSyncJobs.has(session.episodeId),
  }
}

export async function updateSessionPlayerCharacter(sessionId: number, input: {
  global_character_id?: unknown
  generate_default?: unknown
  personality?: unknown
  background?: unknown
  styling?: unknown
  name?: unknown
  role?: unknown
  appearance?: unknown
  physique?: unknown
  description?: unknown
}) {
  if (actingSessions.has(sessionId)) throw new Error('这一幕还在书写，请稍候再编辑角色')
  actingSessions.add(sessionId)
  let loaded: PlayContext
  try {
    loaded = await loadPlay(sessionId)
    let next: PlayerCharacterSnapshot
    let newProjectCharacterId: number | null = null
    let characterChanged = false
    if (!loaded.playerCharacter) {
      if (input.generate_default === true) {
        prepareUncommittedOpeningForCharacterChange(loaded)
        next = await createWorldPlayerCharacter(loaded.world, loaded.session.dramaId, loaded.session.episodeId)
        newProjectCharacterId = next.project_character_id
      } else {
        const globalId = Number(input.global_character_id)
        if (!Number.isInteger(globalId) || globalId <= 0) throw new Error('请先选择一位全局主角')
        const globalCharacter = await getGlobalCharacter(globalId)
        prepareUncommittedOpeningForCharacterChange(loaded)
        next = createGlobalPlayerCharacter(globalCharacter, loaded.session.dramaId, loaded.session.episodeId)
        newProjectCharacterId = next.project_character_id
      }
      characterChanged = true
    } else {
      if (input.global_character_id !== undefined) throw new Error('本局已经绑定主角')
      const current = loaded.playerCharacter
      const [projectCharacter] = await db.select().from(schema.characters).where(eq(schema.characters.id, current.project_character_id))
      if (!projectCharacter) throw new Error('本局主角不存在')
      next = {
        ...current,
        name: normalizePlayerCharacterField(input.name, current.name),
        role: normalizePlayerCharacterField(input.role, current.role),
        appearance: normalizePlayerCharacterField(input.appearance, current.appearance),
        physique: normalizePlayerCharacterField(input.physique, current.physique),
        personality: normalizePlayerCharacterField(input.personality, current.personality),
        background: normalizePlayerCharacterField(input.background, current.background),
        styling: normalizePlayerCharacterField(input.styling, current.styling),
        adapted: current.adapted,
      }
      const description = typeof input.description === 'string' ? input.description : projectCharacter.description
      const changed = next.name !== projectCharacter.name || next.role !== (projectCharacter.role || '')
        || next.appearance !== (projectCharacter.appearance || '') || next.physique !== (projectCharacter.physique || '')
        || next.personality !== (projectCharacter.personality || '') || next.background !== (projectCharacter.background || '')
        || next.styling !== (projectCharacter.styling || '') || (description || '') !== (projectCharacter.description || '')
      if (changed) next.adapted = true
      characterChanged = changed
      if (changed) prepareUncommittedOpeningForCharacterChange(loaded)
      await db.update(schema.characters).set({
        name: next.name,
        role: next.role,
        appearance: next.appearance,
        physique: next.physique,
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        personality: next.personality,
        background: next.background,
        styling: next.styling,
        manualOverride: true,
        ...(changed ? {
          referenceImages: snapshotCharacterReferences(projectCharacter.imageUrl || projectCharacter.localPath, projectCharacter.referenceImages),
          finalPrompt: sql`CASE WHEN ${schema.characters.finalPromptAuto} = 1 THEN NULL ELSE ${schema.characters.finalPrompt} END`,
          imageUrl: null,
          localPath: null,
          imageRevision: sql`${schema.characters.imageRevision} + 1`,
        } : {}),
        updatedAt: now(),
      }).where(eq(schema.characters.id, next.project_character_id))
    }
    loaded.playerCharacter = next
    if (characterChanged && loaded.turns.length === 0 && loaded.session.novelState) {
      const guidance = loaded.novel.userGuidance
      loaded.novel = novelProjectForWorld(loaded.world)
      loaded.novel.userGuidance = guidance
    }
    loaded.novel.userGuidance = withPlayerCharacterGuidance(loaded.novel.userGuidance, next)
    await db.update(schema.rpgSessions).set({
      playerCharacter: JSON.stringify(next),
      novelState: JSON.stringify(loaded.novel),
      updatedAt: now(),
    }).where(eq(schema.rpgSessions.id, sessionId))
  } finally {
    actingSessions.delete(sessionId)
  }
  scheduleEpisodeAssetImages(loaded.session.dramaId, loaded.session.episodeId)
  return getSession(sessionId)
}

function prepareUncommittedOpeningForCharacterChange(loaded: PlayContext) {
  if (loaded.turns.length || !loaded.session.novelState) return
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, loaded.session.episodeId)).get()
  if (!episode) return
  const initialContent = `【世界】${loaded.world.title}\n${loaded.world.premise}\n`
  const content = episode.content || ''
  if ((episode.scriptContent || '').trim() || (content && content !== initialContent && content !== exportNovelToText(loaded.novel))) {
    throw new Error('开场正文或剧本包含无法确认来源的内容，请先在制作台备份并清空后再修改主角')
  }
  if (content !== initialContent) {
    db.update(schema.episodes).set({ content: initialContent, updatedAt: now() })
      .where(eq(schema.episodes.id, episode.id)).run()
  }
}

export async function narrateSession(
  sessionId: number,
  body: { mode?: unknown; choice_id?: unknown; text?: unknown },
  onDelta: (text: string) => Promise<void> | void,
) {
  // 章节按幻书流水线写完再落库。游玩页只展示落库正文，不把半截草稿推到页面上。
  void onDelta
  // 占坑必须发生在 await 之前。两个开场请求若都先越过检查再等待读档,
  // 会各跑一遍 Agent;失败时页面会连着弹出两次「这一幕没有写完」。
  if (actingSessions.has(sessionId)) throw new Error('这一幕还在书写，请稍候')
  actingSessions.add(sessionId)
  try {
    let loaded = await loadPlay(sessionId)
    const pending = assetSyncJobs.get(loaded.session.episodeId)
    if (pending) {
      await pending
      loaded = await loadPlay(sessionId)
    }
    const resolved = resolvePlayerAction(body, loaded.latestChoices, loaded.turns.length > 0)
    if (!resolved.ok) throw new Error(resolved.message)

    const turnIndex = loaded.turns.length + 1
    const actionLine = describeAction(resolved.action, loaded.latestChoices)
    if (loaded.playerCharacter && !loaded.playerCharacter.adapted) {
      await adaptPlayerCharacter(loaded)
    }
    const savedOpening = turnIndex === 1 && resolved.action.mode === 'opening'
      ? loaded.novel.chapters['1']
      : ''
    const narrative = savedOpening
      ? visibleNarrative(savedOpening)
      : await writeNovelChapter(loaded, turnIndex, actionLine)
    if (!narrative) throw new Error('这一幕没有写完，请再试一次')
    let choiceSource = ''
    try {
      choiceSource = await completeNovelPrompt(buildPlayChoicesPrompt(narrative), { timeoutMs: 45_000 })
    } catch (error) {
      console.error('[rpg] choices', error instanceof Error ? error.message : error)
    }
    const rewrite: { source: string; saved?: string } = { source: narrative }
    try {
      await runStudioAgent({
        agentType: 'script_rewriter',
        episodeId: loaded.session.episodeId,
        dramaId: loaded.session.dramaId,
        maxSteps: 10,
        timeoutMs: 90_000,
        screenplayRewrite: rewrite,
        message: '请读取并改写本回合正文，只保存本回合的完整格式化剧本。可以包含多个场景，不要包含此前的剧本。',
      })
    } catch (error) {
      rewrite.saved = undefined
      console.error('[rpg] script_rewriter', error instanceof Error ? error.message : error)
    }
    const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
    const { turn, script, hasLocation } = await commitScreenplay(loaded, resolved.action, narrative, rewrite.saved || '', choiceSource, assets)
    startAssetSync(loaded, turn, script, hasLocation)
    return serializeTurn(turn)
  } finally {
    actingSessions.delete(sessionId)
  }
}

export async function illustrateSession(sessionId: number, options?: { force?: boolean; turnId?: number }) {
  let loaded = await loadPlay(sessionId)
  const pending = assetSyncJobs.get(loaded.session.episodeId)
  if (pending) {
    await pending
    loaded = await loadPlay(sessionId)
  }
  const turn = turnForMedia(loaded, options?.turnId, '还没有可以配图的场面')
  if (turn.imageTaskId) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, turn.imageTaskId))
    if (task && reuseExistingStill(task.status, !!options?.force)) {
      return { task_id: turn.imageTaskId, status: task.status }
    }
  }
  const state = parseJson<RpgWorldState>(turn.worldState, loaded.state)
  const narrative = visibleNarrative(turn.narrative)
  const plates = await platesForTurn(loaded, narrative, state, turn.sceneId, [], [], turn)
  if (!plates.scene) throw new Error('这一幕还没有场景资产。续写时会用提取 Agent 写入场景，请再试一次。')
  const stylePrompt = await getDramaStylePrompt(loaded.session.dramaId)
  const sceneFinalPrompt = plates.sceneFinalPrompt || await ensureScenePlatePrompt(plates.scene, loaded.session.episodeId)
  const prompt = assembleStillPrompt({
    stylePrompt,
    sceneFinalPrompt,
    location: plates.scene.location,
    time: plates.scene.time || state.scene.time,
    scenePrompt: plates.scene.prompt || state.scene.summary,
    lighting: plates.scene.lighting || state.scene.atmosphere,
    characters: plates.promptCharacters,
    narrative,
    references: plates.stillReferences,
  })
  const referenceImages = plates.stillReferences.map(item => item.imageUrl)
  const episode = await readEpisode(loaded.session.episodeId)
  // 剧情图不要写回 sceneId：writeBack 会把成片盖到场景空镜上，后面的镜头就锁不住同一个环境。
  const taskId = await generateImage({
    dramaId: loaded.session.dramaId,
    prompt,
    frameType: PLAY_STILL_FRAME,
    referenceImages: referenceImages.length ? referenceImages : undefined,
    configId: episode?.imageConfigId ?? undefined,
  })
  await db.update(schema.rpgTurns).set({ imageTaskId: taskId, sceneId: plates.scene.id }).where(eq(schema.rpgTurns.id, turn.id))
  return { task_id: taskId, status: 'processing' }
}

export async function filmSession(sessionId: number, options?: { turnId?: number }) {
  let loaded = await loadPlay(sessionId)
  const pending = assetSyncJobs.get(loaded.session.episodeId)
  if (pending) {
    await pending
    loaded = await loadPlay(sessionId)
  }
  const turn = turnForMedia(loaded, options?.turnId, '还没有可以生成影像的场面')
  if (turn.videoTaskId) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, turn.videoTaskId))
    if (task?.status === 'processing' || task?.status === 'completed') {
      return { task_id: turn.videoTaskId, status: task.status }
    }
  }
  const state = parseJson<RpgWorldState>(turn.worldState, loaded.state)
  const storyboardId = await ensurePlayStoryboard(loaded, turn, state)
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId))
  if (!storyboard) throw new Error('这一幕的分镜没有保存下来')
  const narrative = visibleNarrative(turn.narrative)
  const [characterLinks, propLinks] = await Promise.all([
    db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)),
    db.select().from(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, storyboardId)),
  ])
  const platesPromise = platesForTurn(
    loaded,
    narrative,
    state,
    storyboard.sceneId || turn.sceneId,
    characterLinks.map(link => link.characterId),
    propLinks.map(link => link.propId),
    turn,
  ).catch(error => {
    console.error('[rpg] reference plates', error instanceof Error ? error.message : error)
    return {
      scene: null,
      sceneFinalPrompt: '',
      references: [],
      promptCharacters: [],
    }
  })
  let videoPrompt = (storyboard.videoPrompt || '').trim()
  if (!videoPrompt) {
    videoPrompt = await writeStoryboardVideoPrompt(
      loaded.session.episodeId,
      loaded.session.dramaId,
      storyboard,
    )
  }
  if (!videoPrompt) throw new Error('这一幕的视频提示词没有写出来，请再试一次')
  const [stylePrompt, fresh, plates] = await Promise.all([
    getDramaStylePrompt(loaded.session.dramaId),
    refreshTurnMedia(turn),
    platesPromise,
  ])
  const videoReferences = buildStillReferences({
    extras: [
      ...plates.references,
      ...(fresh.imageUrl ? [{ kind: 'still' as const, name: '', imageUrl: fresh.imageUrl }] : []),
    ],
    limit: VIDEO_REFERENCE_LIMIT,
  })
  const referenceImageUrls = videoReferences.map(item => item.imageUrl)
  const taskId = await generateVideo({
    dramaId: loaded.session.dramaId,
    storyboardId,
    prompt: prefixVideoStyle(stylePrompt, applyReferenceMarkers(videoPrompt, videoReferences)),
    imageUrl: fresh.imageUrl || undefined,
    referenceImageUrls: referenceImageUrls.length ? referenceImageUrls : undefined,
    referenceMode: fresh.imageUrl ? 'first_frame' : 'reference',
    duration: storyboard.duration && storyboard.duration > 0 ? storyboard.duration : 6,
    aspectRatio: '16:9',
    resolution: '720p',
  })
  await db.update(schema.rpgTurns).set({ videoTaskId: taskId, storyboardId }).where(eq(schema.rpgTurns.id, turn.id))
  return { task_id: taskId, status: 'processing' }
}

async function commitScreenplay(
  loaded: PlayContext,
  action: ResolvedAction,
  narrative: string,
  rewritten: string,
  choiceSource: string,
  assets: EpisodeAssets,
) {
  return db.transaction((tx) => {
    const episode = tx.select().from(schema.episodes).where(eq(schema.episodes.id, loaded.session.episodeId)).get()
    if (!episode) throw new Error('当前集不存在')
    const { script, screenplay, hasLocation } = appendTurnScreenplay(
      episode.scriptContent || '', rewritten, loaded.state, narrative, action.mode === 'opening' ? null : action.text,
    )
    const preferredSceneId = hasLocation ? sceneIdFromScreenplay(screenplay, assets.scenes) : null
    const projected = projectWorldState(loaded.state, { ...assets, scenes: preferredSceneId ? assets.scenes : [] }, preferredSceneId)
    applyNarrativeLocation(projected, loaded.state, screenplay, hasLocation)
    const choices = resolvePlayChoices([choiceSource, rewritten, script])
    const ts = now()
    const turnIndex = loaded.turns.length + 1
    tx.update(schema.episodes).set({ scriptContent: script, updatedAt: ts }).where(eq(schema.episodes.id, episode.id)).run()
    const res = tx.insert(schema.rpgTurns).values({
      sessionId: loaded.session.id,
      turnIndex,
      playerMode: action.mode,
      playerText: action.text || null,
      choiceId: action.choiceId,
      narrative,
      screenplay,
      choices: JSON.stringify(choices),
      worldState: JSON.stringify(projected.state),
      sceneId: projected.sceneId,
      createdAt: ts,
    }).run()
    tx.update(schema.rpgSessions).set({
      worldState: JSON.stringify(projected.state),
      turnCount: turnIndex,
      updatedAt: ts,
    }).where(eq(schema.rpgSessions.id, loaded.session.id)).run()
    const turn = tx.select().from(schema.rpgTurns).where(eq(schema.rpgTurns.id, getInsertId(res))).get()!
    return { turn, script, hasLocation }
  })
}

const NOVEL_PLAYER_GUIDANCE = '正文使用第一人称「我」，「我」是故事主角。设定里的「你」是在向读者介绍主角。'

function novelProjectForWorld(world: { title: string; premise: string; genre: string | null; tagline: string | null }): NovelProject {
  return createNovelProject({
    title: world.title,
    topic: world.premise,
    genre: world.genre || '其他',
    wordNumber: PLAY_NOVEL_CHAPTER_CHARS,
    userGuidance: [world.tagline || '', NOVEL_PLAYER_GUIDANCE].filter(Boolean).join('\n'),
  })
}

function readNovelProject(raw: string | null | undefined, world: { title: string; premise: string; genre: string | null; tagline: string | null }): NovelProject {
  const seed = novelProjectForWorld(world)
  if (!raw) return seed
  try {
    const parsed = JSON.parse(raw) as Partial<NovelProject>
    if (!parsed || typeof parsed !== 'object') return seed
    return settleNovelProject({
      ...seed,
      ...parsed,
      chapters: parsed.chapters && typeof parsed.chapters === 'object' ? parsed.chapters : {},
      userGuidance: parsed.userGuidance || seed.userGuidance,
    })
  } catch {
    return seed
  }
}

async function saveNovelProject(sessionId: number, project: NovelProject) {
  await db.update(schema.rpgSessions).set({
    novelState: JSON.stringify(project),
    updatedAt: now(),
  }).where(eq(schema.rpgSessions.id, sessionId))
}

async function writeNovelChapter(loaded: PlayContext, turnIndex: number, actionLine: string): Promise<string> {
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
  const characterGuidance = formatWorldCharacterGuidance(assets.characters)
  const chapterUserGuidance = [
    loaded.novel.userGuidance,
    characterGuidance ? `当前世界角色设定：\n${characterGuidance}` : '',
    actionLine,
  ].filter(Boolean).join('\n\n')
  const produced = await produceNovelChapter(loaded.novel, turnIndex, completeNovelPrompt, {
    maxTokens: NOVEL_MAX_TOKENS,
    chapterUserGuidance,
    normalizeChapterText: visibleNarrative,
    onProject: async (partial) => {
      await saveNovelProject(loaded.session.id, partial)
    },
  })
  if (!produced.chapterText.trim()) throw new Error('这一幕没有写完，请再试一次')
  await db.update(schema.episodes).set({
    content: exportNovelToText(produced.project),
    updatedAt: now(),
  }).where(eq(schema.episodes.id, loaded.session.episodeId))
  return produced.chapterText
}

async function adaptPlayerCharacter(loaded: PlayContext) {
  const character = loaded.playerCharacter
  if (!character) return
  let adapted = fallbackPlayerCharacter(character)
  try {
    const answer = await completeNovelPrompt([
      '请把一个全局角色改编为当前世界中的主角版本。只改性格表达、背景经历和服装，不改变姓名、身份核心、脸部外貌和身材。',
      `世界名称：${loaded.world.title}`,
      `世界类型：${loaded.world.genre || '原创'}`,
      `世界设定：${loaded.world.premise}`,
      `角色姓名：${character.name}`,
      `角色身份：${character.role}`,
      `固定外貌：${character.appearance}`,
      `固定身材：${character.physique}`,
      `默认性格：${character.default_personality}`,
      `默认服装：${character.default_styling}`,
      '返回 JSON 对象，字段为 personality、background、styling，值均为简体中文字符串。不要返回 Markdown。',
    ].join('\n\n'), { timeoutMs: 45_000 })
    adapted = adaptPlayerCharacterResponse(character, answer)
  } catch (error) {
    console.error('[rpg] player-character-adaptation', error instanceof Error ? error.message : error)
  }
  loaded.playerCharacter = adapted
  loaded.novel.userGuidance = withPlayerCharacterGuidance(loaded.novel.userGuidance, adapted)
  const ts = now()
  await db.update(schema.rpgSessions).set({
    playerCharacter: JSON.stringify(adapted),
    novelState: JSON.stringify(loaded.novel),
    updatedAt: ts,
  }).where(eq(schema.rpgSessions.id, loaded.session.id))
  await db.update(schema.characters).set({
    personality: adapted.personality,
    background: adapted.background,
    styling: adapted.styling,
    finalPrompt: sql`CASE WHEN ${schema.characters.finalPromptAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.finalPrompt} END`,
    imageUrl: sql`CASE WHEN ${schema.characters.imageAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.imageUrl} END`,
    localPath: sql`CASE WHEN ${schema.characters.imageAuto} = 1 AND COALESCE(${schema.characters.styling}, '') <> ${adapted.styling} THEN NULL ELSE ${schema.characters.localPath} END`,
    imageRevision: sql`${schema.characters.imageRevision} + 1`,
    updatedAt: ts,
  }).where(eq(schema.characters.id, character.project_character_id))
  scheduleEpisodeAssetImages(loaded.session.dramaId, loaded.session.episodeId)
}

async function syncAssets(episodeId: number, dramaId: number, script: string) {
  const results = await Promise.allSettled(
    EXTRACT_TARGETS.map(target => runExtraction(episodeId, dramaId, target, { script })),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
      console.error('[rpg] extractor', message)
    }
  }
}

function startAssetSync(
  loaded: PlayContext,
  turn: typeof schema.rpgTurns.$inferSelect,
  script: string,
  hasLocation: boolean,
) {
  const episodeId = loaded.session.episodeId
  const previous = assetSyncJobs.get(episodeId) || Promise.resolve()
  let job: Promise<void>
  job = previous.catch(() => undefined).then(async () => {
    await syncAssets(episodeId, loaded.session.dramaId, script)
    scheduleEpisodeAssetImages(loaded.session.dramaId, episodeId)
    const assets = await loadEpisodeAssets(loaded.session.dramaId, episodeId)
    const preferredSceneId = hasLocation ? sceneIdFromScreenplay(turn.screenplay || '', assets.scenes) : null
    const projected = projectWorldState(loaded.state, { ...assets, scenes: preferredSceneId ? assets.scenes : [] }, preferredSceneId)
    applyNarrativeLocation(projected, loaded.state, turn.screenplay || '', hasLocation)
    await db.update(schema.rpgTurns).set({
      worldState: JSON.stringify(projected.state),
      sceneId: projected.sceneId,
    }).where(eq(schema.rpgTurns.id, turn.id))
    await db.update(schema.rpgSessions).set({
      worldState: JSON.stringify(projected.state),
      updatedAt: now(),
    }).where(and(
      eq(schema.rpgSessions.id, loaded.session.id),
      eq(schema.rpgSessions.turnCount, turn.turnIndex),
    ))
  }).catch(error => {
    console.error('[rpg] asset sync', error instanceof Error ? error.message : error)
  }).finally(() => {
    if (assetSyncJobs.get(episodeId) === job) assetSyncJobs.delete(episodeId)
  })
  assetSyncJobs.set(episodeId, job)
}

function applyNarrativeLocation(
  projected: { state: RpgWorldState; sceneId: number | null },
  previous: RpgWorldState,
  screenplay: string,
  hasLocation: boolean,
) {
  if (projected.sceneId) return
  const header = hasLocation ? lastScreenplayLocation(screenplay) : null
  if (!header) return
  projected.state.scene = { ...previous.scene, location: header.location, time: header.time }
}

async function platesForTurn(
  loaded: PlayContext,
  narrative: string,
  state: RpgWorldState,
  sceneId: number | null,
  boundCharacterIds: number[],
  boundPropIds: number[],
  turn: typeof schema.rpgTurns.$inferSelect,
) {
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
  let scene: typeof schema.scenes.$inferSelect | null = null
  try {
    scene = await sceneForTurn(loaded, sceneId, turn)
  } catch {
    scene = null
  }
  const characters = selectPlayCharacters(assets.characters, narrative, boundCharacterIds)
  const props = selectPlayProps(assets.props, narrative, boundPropIds)
  const waitUntil = Date.now() + PLAY_REFERENCE_WAIT_MS
  const base = {
    episodeId: loaded.session.episodeId,
    skipIfPresent: true,
    retryFailed: true,
    resolveConfigFromEpisode: true,
    waitUntil,
  }
  const [scenePlate, characterPlates, propPlates] = await Promise.all([
    scene ? resolveAssetReferenceImage('scene', scene.id, base) : Promise.resolve({ taskId: null, imageUrl: null, finalPrompt: '' }),
    Promise.all(characters.map(item => resolveAssetReferenceImage('character', item.id, base))),
    Promise.all(props.map(item => resolveAssetReferenceImage('prop', item.id, base))),
  ])
  const plateInput = {
    scene: scene ? { name: scene.location, imageUrl: scenePlate.imageUrl } : null,
    characters: characters.map((item, index) => ({
      name: item.name,
      role: 'role' in item ? item.role : null,
      imageUrl: characterPlates[index]?.imageUrl,
    })),
    props: props.map((item, index) => ({ name: item.name, imageUrl: propPlates[index]?.imageUrl })),
  }
  const references = prioritizeStillReferences({ ...plateInput, limit: STILL_REFERENCE_LIMIT })
  const stillReferences = prioritizeStillReferences({ ...plateInput, limit: PLAY_STILL_REFERENCE_LIMIT })
  return {
    scene,
    sceneFinalPrompt: scenePlate.finalPrompt,
    references,
    stillReferences,
    promptCharacters: stillPromptCharacters(characters, state.characters),
  }
}

async function ensureScenePlatePrompt(scene: typeof schema.scenes.$inferSelect, episodeId: number) {
  const [fresh] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, scene.id))
  if (!fresh || fresh.deletedAt) return scene.finalPrompt || ''
  if (fresh.finalPrompt) return fresh.finalPrompt
  return ensureSceneFinalPrompt(fresh, episodeId, false)
}

async function sceneForTurn(loaded: PlayContext, sceneId: number | null, turn: typeof schema.rpgTurns.$inferSelect) {
  if (sceneId) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (scene && !scene.deletedAt) return scene
  }
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
  if (turn.screenplay !== null) {
    // 提取重试或后续回合可能才补齐场景，按本回合剧本恢复绑定。
    const matchedId = sceneIdFromScreenplay(turn.screenplay, assets.scenes)
    const matched = assets.scenes.find(scene => scene.id === matchedId)
    if (!matched) throw new Error('这一幕还没有匹配的场景资产')
    await db.update(schema.rpgTurns).set({ sceneId: matched.id }).where(eq(schema.rpgTurns.id, turn.id))
    return matched
  }
  const latest = assets.scenes[assets.scenes.length - 1]
  if (!latest) throw new Error('这一幕还没有场景资产。续写时会用提取 Agent 写入场景，请再试一次。')
  return latest
}

async function ensurePlayStoryboard(
  loaded: PlayContext,
  turn: typeof schema.rpgTurns.$inferSelect,
  state: RpgWorldState,
) {
  if (turn.storyboardId) return turn.storyboardId
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
  const episode = await readEpisode(loaded.session.episodeId)
  const prose = visibleNarrative(turn.narrative)
  const currentScreenplay = turn.screenplay && currentTurnScreenplay(episode?.scriptContent || '', turn.screenplay)
  const screenplay = currentScreenplay
    ? narrativeBlock(currentScreenplay)
    : formatScreenplayScene(turn.turnIndex, state, prose, turn.playerText)
  const videoLabel = await videoModelLabel(loaded.session.episodeId)
  try {
    await runStudioAgent({
      agentType: 'storyboard_breaker',
      episodeId: loaded.session.episodeId,
      dramaId: loaded.session.dramaId,
      maxSteps: 20,
      storyboardShotNumber: turn.turnIndex,
      storyboardScript: screenplay,
      message: buildPlayStoryboardMessage({
        turnIndex: turn.turnIndex,
        narrative: prose,
        screenplay,
        videoLabel,
        characters: assets.characters.map(item => ({ id: item.id, name: item.name })),
        scenes: assets.scenes.map(item => ({ id: item.id, location: item.location, time: item.time })),
        props: assets.props.map(item => ({ id: item.id, name: item.name })),
      }),
    })
  } catch (error) {
    console.error('[rpg] storyboard_breaker', error instanceof Error ? error.message : error)
  }
  const boards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, loaded.session.episodeId))
  const matched = boards.find(item => item.storyboardNumber === turn.turnIndex && !item.deletedAt)
  const storyboardId = matched?.id || await insertFallbackStoryboard(loaded, turn, state, assets)
  const sceneId = matched?.sceneId || turn.sceneId
  await db.update(schema.rpgTurns).set({ storyboardId, sceneId }).where(eq(schema.rpgTurns.id, turn.id))
  return storyboardId
}

function narrativeBlock(script: string) {
  return script.trim()
    .split('\n')
    .map(line => {
      const trimmed = line.trim()
      if (!trimmed || /^##\s*S\d+\b/.test(trimmed) || /^（玩家行动）/.test(trimmed)) return line
      return stripPipelineMeta(line)
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function insertFallbackStoryboard(
  loaded: PlayContext,
  turn: typeof schema.rpgTurns.$inferSelect,
  state: RpgWorldState,
  assets: EpisodeAssets,
) {
  const ts = now()
  const sceneId = turn.sceneId || (turn.screenplay === null
    ? assets.scenes.find(item => item.location === state.scene.location)?.id || assets.scenes[0]?.id || null
    : null)
  const res = await db.insert(schema.storyboards).values({
    episodeId: loaded.session.episodeId,
    sceneId,
    storyboardNumber: turn.turnIndex,
    title: state.scene.location,
    location: state.scene.location,
    time: state.scene.time,
    description: `【镜头1】${visibleNarrative(turn.narrative)}`,
    atmosphere: state.scene.atmosphere,
    duration: 6,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  })
  const storyboardId = getInsertId(res)
  for (const character of assets.characters) {
    const [existing] = await db.select().from(schema.storyboardCharacters).where(and(
      eq(schema.storyboardCharacters.storyboardId, storyboardId),
      eq(schema.storyboardCharacters.characterId, character.id),
    ))
    if (existing) continue
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId: character.id,
    })
  }
  return storyboardId
}

async function loadEpisodeAssets(dramaId: number, episodeId: number): Promise<EpisodeAssets> {
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const characterIds = new Set(characterLinks.map(link => link.characterId))
  const sceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const propIds = new Set(propLinks.map(link => link.propId))
  const characters = (await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId)))
    .filter(item => characterIds.has(item.id) && !item.deletedAt)
  const scenes = (await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId)))
    .filter(item => sceneIds.has(item.id) && !item.deletedAt)
  const props = (await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId)))
    .filter(item => propIds.has(item.id) && !item.deletedAt)
  return { characters, scenes, props }
}

async function refreshTurnMedia(turn: typeof schema.rpgTurns.$inferSelect) {
  let imageUrl = turn.imageUrl
  let videoUrl = turn.videoUrl
  const imageTask = turn.imageTaskId ? await readTask(turn.imageTaskId) : null
  const videoTask = turn.videoTaskId ? await readTask(turn.videoTaskId) : null
  if (imageTask?.status === 'completed') {
    const next = imageTask.localPath || imageTask.resultUrl
    if (next && next !== imageUrl) imageUrl = next
  }
  if (videoTask?.status === 'completed') {
    const next = videoTask.localPath || videoTask.resultUrl
    if (next && next !== videoUrl) videoUrl = next
  }
  if (imageUrl !== turn.imageUrl || videoUrl !== turn.videoUrl) {
    await db.update(schema.rpgTurns).set({ imageUrl, videoUrl }).where(eq(schema.rpgTurns.id, turn.id))
  }
  return { ...turn, imageUrl, videoUrl, imageTask, videoTask }
}

async function readTask(id: number) {
  const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  return task || null
}

async function readEpisode(episodeId: number) {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  return episode || null
}

interface EpisodeAssets {
  characters: Array<typeof schema.characters.$inferSelect>
  scenes: Array<typeof schema.scenes.$inferSelect>
  props: Array<typeof schema.props.$inferSelect>
}

interface PlayContext {
  session: typeof schema.rpgSessions.$inferSelect
  world: typeof schema.rpgWorlds.$inferSelect
  turns: Array<typeof schema.rpgTurns.$inferSelect>
  state: RpgWorldState
  latestChoices: RpgChoice[]
  novel: NovelProject
  playerCharacter: PlayerCharacterSnapshot | null
}

function turnForMedia(loaded: PlayContext, turnId: number | undefined, emptyMessage: string) {
  const turn = pickSessionTurn(loaded.turns, turnId)
  if (turn) return turn
  throw new Error(turnId == null ? emptyMessage : '这一幕不在这局游戏里')
}

async function loadPlay(sessionId: number): Promise<PlayContext> {
  const [session] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, sessionId))
  if (!session || session.playKind === NOVEL_PLAY_KIND) throw new Error('这局游戏不存在')
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, session.worldId))
  if (!world) throw new Error('世界不存在')
  const turns = await db.select().from(schema.rpgTurns)
    .where(eq(schema.rpgTurns.sessionId, sessionId))
    .orderBy(asc(schema.rpgTurns.turnIndex))
  const latest = turns[turns.length - 1]
  const playerCharacter = parseJson<PlayerCharacterSnapshot | null>(session.playerCharacter, null)
  const novel = readNovelProject(session.novelState, world)
  if (playerCharacter) novel.userGuidance = withPlayerCharacterGuidance(novel.userGuidance, playerCharacter)
  return {
    session,
    world,
    turns,
    state: parseJson<RpgWorldState>(session.worldState, emptyWorldState(world.premise)),
    latestChoices: latest ? parseJson<RpgChoice[]>(latest.choices, []) : [],
    novel,
    playerCharacter,
  }
}

async function mustWorld(id: number) {
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, id))
  if (!world) throw new Error('世界不存在')
  return world
}

async function getGlobalCharacter(id: number) {
  const [character] = await db.select().from(schema.globalCharacters).where(eq(schema.globalCharacters.id, id))
  if (!character || character.deletedAt) throw new Error('全局角色不存在')
  return character
}

async function createCustomWorld(input: { title?: string; premise?: string; genre?: string; tagline?: string }) {
  const title = String(input.title || '').trim()
  const premise = String(input.premise || '').trim()
  if (!title) throw new Error('给这个世界起个名字')
  if (premise.length < 20) throw new Error('世界设定至少写 20 字，才知道从哪一幕写起')
  if (premise.length > 2000) throw new Error('世界设定请控制在 2000 字以内')
  const ts = now()
  const seed: WorldSeed = {
    slug: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: title.slice(0, 40),
    tagline: String(input.tagline || '').trim().slice(0, 40),
    premise,
    genre: String(input.genre || '原创').trim().slice(0, 20) || '原创',
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
  }
  const res = await db.insert(schema.rpgWorlds).values({
    ...seed,
    isPreset: false,
    createdAt: ts,
    updatedAt: ts,
  })
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, getInsertId(res)))
  if (!world) throw new Error('世界没有保存成功')
  return world
}

function serializeWorld(world: typeof schema.rpgWorlds.$inferSelect) {
  return {
    id: world.id,
    slug: world.slug,
    title: world.title,
    tagline: world.tagline,
    premise: world.premise,
    genre: world.genre,
    style: world.style,
    is_preset: !!world.isPreset,
  }
}

function serializeTurn(turn: typeof schema.rpgTurns.$inferSelect & {
  imageTask?: typeof schema.sysTask.$inferSelect | null
  videoTask?: typeof schema.sysTask.$inferSelect | null
}) {
  return {
    id: turn.id,
    turn_index: turn.turnIndex,
    player_mode: turn.playerMode,
    player_text: turn.playerText,
    choice_id: turn.choiceId,
    narrative: visibleNarrative(turn.narrative),
    choices: parseJson<RpgChoice[]>(turn.choices, []),
    world_state: parseJson<RpgWorldState>(turn.worldState, emptyWorldState()),
    scene_id: turn.sceneId,
    storyboard_id: turn.storyboardId,
    image_url: publicAssetPath(turn.imageUrl),
    video_url: publicAssetPath(turn.videoUrl),
    image_status: turn.imageTask?.status || (turn.imageUrl ? 'completed' : null),
    video_status: turn.videoTask?.status || (turn.videoUrl ? 'completed' : null),
    image_error: turn.imageTask?.status === 'failed' ? turn.imageTask.errorMsg : null,
    video_error: turn.videoTask?.status === 'failed' ? turn.videoTask.errorMsg : null,
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
