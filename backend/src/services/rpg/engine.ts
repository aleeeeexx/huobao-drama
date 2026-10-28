/**
 * 织界对局编排。
 * 玩家看到的是流式叙事、分支和自由行动。创作本身走短剧工作室：
 * script_rewriter 续写剧本，extractor 同步资产，插画用 prompt_generator 的场景提示词，
 * 影像用 storyboard_breaker 追加本幕分镜，再由 prompt_generator 写视频提示词。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { generateImage, generateVideo } from '../generation.js'
import { EXTRACT_TARGETS, runExtraction } from '../extraction.js'
import { getDramaStylePrompt, prefixVideoStyle } from '../style-preset.js'
import { ensureSceneFinalPrompt } from '../final-prompt.js'
import { resolveAssetReferenceImage, scheduleEpisodeAssetImages } from '../asset-images.js'
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
import { LIVE_ACTION_CINEMATIC_STYLE } from '../live-action-cinematic.js'
import { now } from '../../utils/response.js'
import { PRESET_WORLDS, type WorldSeed } from './worlds.js'
import {
  assembleStillPrompt,
  buildPlayRewriteMessage,
  buildPlayStoryboardMessage,
  describeAction,
  emptyWorldState,
  formatScreenplayScene,
  locationFromNarrativeHeader,
  narrativeFromScreenplay,
  NarrativeStreamParser,
  projectWorldState,
  resolvePlayerAction,
  resolvePlayChoices,
  sceneIdFromScreenplay,
  scriptHasScene,
  stripChoiceTail,
  stripPipelineMeta,
  visibleNarrative,
  type ResolvedAction,
  type RpgChoice,
  type RpgWorldState,
} from './turn.js'

const actingSessions = new Set<number>()

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
  const rows = await db.select().from(schema.rpgSessions).orderBy(desc(schema.rpgSessions.updatedAt)).limit(20)
  return rows.map(row => ({
    id: row.id,
    title: row.title,
    status: row.status,
    turn_count: row.turnCount || 0,
    updated_at: row.updatedAt,
    drama_id: row.dramaId,
  }))
}

export async function createSession(input: {
  world_id?: number
  title?: string
  premise?: string
  genre?: string
  tagline?: string
}) {
  await ensurePresetWorlds()
  const world = input.world_id
    ? await mustWorld(input.world_id)
    : await createCustomWorld(input)
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
    title: '织界正文',
    content: `【世界】${world.title}\n${world.premise}\n`,
    scriptContent: '',
    description: world.tagline,
    status: 'draft',
    resolution: '720p',
    createdAt: ts,
    updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)
  const sessionRes = await db.insert(schema.rpgSessions).values({
    worldId: world.id,
    dramaId,
    episodeId,
    title: world.title,
    status: 'active',
    worldState: JSON.stringify(state),
    turnCount: 0,
    createdAt: ts,
    updatedAt: ts,
  })
  const sessionId = getInsertId(sessionRes)
  await db.update(schema.dramas)
    .set({ metadata: JSON.stringify({ source: 'rpg', session_id: sessionId }) })
    .where(eq(schema.dramas.id, dramaId))
  return getSession(sessionId)
}

export async function getSession(sessionId: number) {
  const [session] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, sessionId))
  if (!session) return null
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, session.worldId))
  const turns = await db.select().from(schema.rpgTurns)
    .where(eq(schema.rpgTurns.sessionId, sessionId))
    .orderBy(asc(schema.rpgTurns.turnIndex))
  const refreshed = []
  for (const turn of turns) refreshed.push(await refreshTurnMedia(turn))
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    drama_id: session.dramaId,
    episode_id: session.episodeId,
    turn_count: session.turnCount || 0,
    world: world ? serializeWorld(world) : null,
    world_state: parseJson<RpgWorldState>(session.worldState, emptyWorldState()),
    turns: refreshed.map(serializeTurn),
    acting: actingSessions.has(sessionId),
  }
}

export async function narrateSession(
  sessionId: number,
  body: { mode?: unknown; choice_id?: unknown; text?: unknown },
  onDelta: (text: string) => Promise<void> | void,
) {
  // 占坑必须发生在 await 之前。两个开场请求若都先越过检查再等待读档,
  // 会各跑一遍 Agent;失败时页面会连着弹出两次「这一幕没有写完」。
  if (actingSessions.has(sessionId)) throw new Error('这一幕还在书写，请稍候')
  actingSessions.add(sessionId)
  try {
    const loaded = await loadPlay(sessionId)
    const resolved = resolvePlayerAction(body, loaded.latestChoices, loaded.turns.length > 0)
    if (!resolved.ok) throw new Error(resolved.message)

    const turnIndex = loaded.turns.length + 1
    const actionLine = describeAction(resolved.action, loaded.latestChoices)
    const episode = await readEpisode(loaded.session.episodeId)
    const parser = new NarrativeStreamParser()
    const run = await runStudioAgent({
      agentType: 'script_rewriter',
      episodeId: loaded.session.episodeId,
      dramaId: loaded.session.dramaId,
      maxSteps: 10,
      message: buildPlayRewriteMessage({
        worldTitle: loaded.world.title,
        genre: loaded.world.genre || '',
        premise: loaded.world.premise,
        actionLine,
        turnIndex,
        existingScript: episode?.scriptContent || '',
        recent: loaded.recent,
      }),
      onTextDelta: async (delta) => {
        const visible = parser.push(delta)
        if (visible) await onDelta(visible)
      },
    })
    parser.absorbFinalText(run.text || '')
    const finished = parser.finish()
    if (finished.tail) await onDelta(finished.tail)
    const savedEpisode = await readEpisode(loaded.session.episodeId)
    const choices = resolvePlayChoices([
      finished.stateRaw,
      finished.rawNarrative,
      savedEpisode?.scriptContent || '',
    ])
    await commitScreenplay(loaded, turnIndex, resolved.action, finished.rawNarrative)
    const scriptEpisode = await readEpisode(loaded.session.episodeId)
    const script = scriptEpisode?.scriptContent || ''
    const narrative = finished.narrative || narrativeFromScreenplay(script, turnIndex)
    if (!narrative) throw new Error('这一幕没有写完，请再试一次')
    await syncAssets(loaded.session.episodeId, loaded.session.dramaId)
    scheduleEpisodeAssetImages(loaded.session.dramaId, loaded.session.episodeId)
    const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
    const preferredSceneId = sceneIdFromScreenplay(script, turnIndex, assets.scenes)
    const projected = projectWorldState(loaded.state, assets, preferredSceneId)
    const turn = await persistTurn(loaded, resolved.action, narrative, choices, projected.state, projected.sceneId)
    await appendManuscript(loaded.session.episodeId, turnIndex, resolved.action, narrative)
    return serializeTurn(turn)
  } finally {
    actingSessions.delete(sessionId)
  }
}

export async function illustrateSession(sessionId: number, options?: { force?: boolean }) {
  const loaded = await loadPlay(sessionId)
  const turn = loaded.turns[loaded.turns.length - 1]
  if (!turn) throw new Error('还没有可以配图的场面')
  if (turn.imageTaskId) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, turn.imageTaskId))
    if (task && reuseExistingStill(task.status, !!options?.force)) {
      return { task_id: turn.imageTaskId, status: task.status }
    }
  }
  const state = parseJson<RpgWorldState>(turn.worldState, loaded.state)
  const narrative = visibleNarrative(turn.narrative)
  const plates = await platesForTurn(loaded, narrative, state, turn.sceneId, [], [])
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

export async function filmSession(sessionId: number) {
  const loaded = await loadPlay(sessionId)
  const turn = loaded.turns[loaded.turns.length - 1]
  if (!turn) throw new Error('还没有可以生成影像的场面')
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
  turnIndex: number,
  action: ResolvedAction,
  narrative: string,
) {
  const episode = await readEpisode(loaded.session.episodeId)
  if (!episode) return
  let script = stripChoiceTail(episode.scriptContent || '')
  const prose = visibleNarrative(narrative) || narrativeFromScreenplay(script, turnIndex)
  if (prose && !scriptHasScene(script, turnIndex)) {
    const header = locationFromNarrativeHeader(narrative)
    const stateForScene = header
      ? { ...loaded.state, scene: { ...loaded.state.scene, location: header.location, time: header.time } }
      : loaded.state
    const scene = formatScreenplayScene(
      turnIndex,
      stateForScene,
      prose,
      action.mode === 'opening' ? null : action.text,
    )
    script = `${script}${script ? '\n\n' : ''}${scene}`
  }
  if (script === (episode.scriptContent || '')) return
  await db.update(schema.episodes).set({
    scriptContent: script,
    updatedAt: now(),
  }).where(eq(schema.episodes.id, episode.id))
}

async function appendManuscript(episodeId: number, turnIndex: number, action: ResolvedAction, narrative: string) {
  const episode = await readEpisode(episodeId)
  if (!episode) return
  const playerLine = action.mode === 'opening' ? '' : `\n玩家：${action.text}`
  const content = `${episode.content || ''}\n\n【第${turnIndex}幕】${playerLine}\n${narrative}\n`
  await db.update(schema.episodes).set({
    content,
    updatedAt: now(),
  }).where(eq(schema.episodes.id, episodeId))
}

async function syncAssets(episodeId: number, dramaId: number) {
  const results = await Promise.allSettled(
    EXTRACT_TARGETS.map(target => runExtraction(episodeId, dramaId, target)),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
      console.error('[rpg] extractor', message)
    }
  }
}

async function persistTurn(
  loaded: PlayContext,
  action: ResolvedAction,
  narrative: string,
  choices: RpgChoice[],
  state: RpgWorldState,
  sceneId: number | null,
) {
  const ts = now()
  const turnIndex = loaded.turns.length + 1
  const res = await db.insert(schema.rpgTurns).values({
    sessionId: loaded.session.id,
    turnIndex,
    playerMode: action.mode,
    playerText: action.text || null,
    choiceId: action.choiceId,
    narrative,
    choices: JSON.stringify(choices),
    worldState: JSON.stringify(state),
    sceneId,
    createdAt: ts,
  })
  const turnId = getInsertId(res)
  await db.update(schema.rpgSessions).set({
    worldState: JSON.stringify(state),
    turnCount: turnIndex,
    updatedAt: ts,
  }).where(eq(schema.rpgSessions.id, loaded.session.id))
  const [turn] = await db.select().from(schema.rpgTurns).where(eq(schema.rpgTurns.id, turnId))
  return turn
}

async function platesForTurn(
  loaded: PlayContext,
  narrative: string,
  state: RpgWorldState,
  sceneId: number | null,
  boundCharacterIds: number[],
  boundPropIds: number[],
) {
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
  let scene: typeof schema.scenes.$inferSelect | null = null
  try {
    scene = await sceneForTurn(loaded, sceneId)
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

async function sceneForTurn(loaded: PlayContext, sceneId: number | null) {
  if (sceneId) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (scene && !scene.deletedAt) return scene
  }
  const assets = await loadEpisodeAssets(loaded.session.dramaId, loaded.session.episodeId)
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
  const screenplay = scriptHasScene(episode?.scriptContent || '', turn.turnIndex)
    ? narrativeBlock(episode?.scriptContent || '', turn.turnIndex)
    : formatScreenplayScene(turn.turnIndex, state, prose, turn.playerText)
  const videoLabel = await videoModelLabel(loaded.session.episodeId)
  try {
    await runStudioAgent({
      agentType: 'storyboard_breaker',
      episodeId: loaded.session.episodeId,
      dramaId: loaded.session.dramaId,
      maxSteps: 20,
      storyboardShotNumber: turn.turnIndex,
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

function narrativeBlock(script: string, turnIndex: number) {
  const match = script.match(new RegExp(`##\\s*S${turnIndex}\\b[\\s\\S]*?(?=\\n##\\s*S\\d+\\b|$)`))
  const block = match?.[0]?.trim() || script
  return block
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
  const sceneId = turn.sceneId || assets.scenes.find(item => item.location === state.scene.location)?.id || assets.scenes[0]?.id || null
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
  recent: string
}

async function loadPlay(sessionId: number): Promise<PlayContext> {
  const [session] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, sessionId))
  if (!session) throw new Error('这局游戏不存在')
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, session.worldId))
  if (!world) throw new Error('世界不存在')
  const turns = await db.select().from(schema.rpgTurns)
    .where(eq(schema.rpgTurns.sessionId, sessionId))
    .orderBy(asc(schema.rpgTurns.turnIndex))
  const latest = turns[turns.length - 1]
  const recent = turns.slice(-4).map(turn => {
    const player = turn.playerText ? `玩家：${turn.playerText}\n` : ''
    return `第${turn.turnIndex}幕\n${player}${visibleNarrative(turn.narrative)}`
  }).join('\n\n')
  return {
    session,
    world,
    turns,
    state: parseJson<RpgWorldState>(session.worldState, emptyWorldState(world.premise)),
    latestChoices: latest ? parseJson<RpgChoice[]>(latest.choices, []) : [],
    recent,
  }
}

async function mustWorld(id: number) {
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, id))
  if (!world) throw new Error('世界不存在')
  return world
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

function publicAssetPath(value: string | null | undefined) {
  if (!value) return null
  if (/^https?:\/\//.test(value)) return value
  return `/${value.replace(/^\/+/, '')}`
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
