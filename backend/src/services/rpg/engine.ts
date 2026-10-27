/**
 * 织界对局编排。
 * 玩家看到的是流式叙事 + 选项/自由行动；每一幕同时写入短剧的 episode，
 * 并异步调用 script_rewriter 把正文续写成剧本。插画和视频走现有 sys_task 管线。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { buildAgentRequestContext } from '../../agents/context.js'
import { mastra } from '../../mastra/index.js'
import { getTextConfig, getTextProviderBaseUrl } from '../ai.js'
import { generateImage, generateVideo } from '../generation.js'
import { LIVE_ACTION_CINEMATIC_STYLE } from '../live-action-cinematic.js'
import { now } from '../../utils/response.js'
import { PRESET_WORLDS, type WorldSeed } from './worlds.js'
import {
  buildSceneImagePrompt,
  buildSceneVideoPrompt,
  describeAction,
  emptyWorldState,
  formatScreenplayScene,
  NarrativeStreamParser,
  parseStatePayload,
  resolvePlayerAction,
  type ResolvedAction,
  type RpgChoice,
  type RpgWorldState,
} from './turn.js'

const actingSessions = new Set<number>()

const NARRATOR_SYSTEM = `你是互动文字 RPG「织界」的说书人。玩家每回合要么点选一个剧情走向，要么写下自己的行动，二者同等有效，都必须真正改变局面。

输出格式（必须遵守）：
1. 先写叙事正文：简体中文，第二人称「你」，280 到 420 字，一段或两段，有画面、有后果。不要分点，不要写「选项」，不要出现分隔符。
2. 正文结束后另起一行，只输出一次分隔符 <<<RPG_STATE>>>
3. 分隔符后输出一个 JSON 对象，不要使用 markdown 代码块。

JSON 字段：
- choices：恰好 3 个。id 为 c1、c2、c3。label 不超过 18 字，detail 不超过 36 字。三条方向必须不同，且都是玩家此刻做得成的事。
- scene：location、time、summary（当前画面一两句）、atmosphere
- characters：name、role、status（当前处境）、appearance。保留仍在场的人，不要无故删除。
- items：name、holder、description。玩家还拿着的东西要留下。
- quests：title、status（只能是 active、done、failed）、detail
- memory：120 字以内的滚动摘要，供下一回合使用`

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
  if (actingSessions.has(sessionId)) throw new Error('这一幕还在书写，请稍候')
  const loaded = await loadPlay(sessionId)
  const resolved = resolvePlayerAction(body, loaded.latestChoices, loaded.turns.length > 0)
  if (!resolved.ok) throw new Error(resolved.message)

  actingSessions.add(sessionId)
  try {
    const previous = loaded.state
    const actionLine = describeAction(resolved.action, loaded.latestChoices)
    const messages = buildMessages(loaded.world, previous, loaded.recent, actionLine)
    const parser = new NarrativeStreamParser()
    for await (const delta of streamNarration(messages)) {
      const visible = parser.push(delta)
      if (visible) await onDelta(visible)
    }
    const finished = parser.finish()
    if (!finished.narrative) throw new Error('说书人没有写出这一幕，请再试一次')
    const parsed = parseStatePayload(finished.stateRaw, previous)
    const turn = await persistTurn(loaded, resolved.action, finished.narrative, parsed.choices, parsed.state)
    return serializeTurn(turn)
  } finally {
    actingSessions.delete(sessionId)
  }
}

export async function illustrateSession(sessionId: number) {
  const loaded = await loadPlay(sessionId)
  const turn = loaded.turns[loaded.turns.length - 1]
  if (!turn) throw new Error('还没有可以配图的场面')
  if (turn.imageTaskId) {
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, turn.imageTaskId))
    if (task?.status === 'processing' || task?.status === 'completed') {
      return { task_id: turn.imageTaskId, status: task.status }
    }
  }
  const sceneId = await ensureScene(loaded, turn)
  const prompt = buildSceneImagePrompt(parseJson<RpgWorldState>(turn.worldState, loaded.state))
  const taskId = await generateImage({
    dramaId: loaded.session.dramaId,
    sceneId,
    prompt,
    size: '1024x1024',
  })
  await db.update(schema.rpgTurns).set({ imageTaskId: taskId, sceneId }).where(eq(schema.rpgTurns.id, turn.id))
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
  const storyboardId = await ensureStoryboard(loaded, turn, state)
  const fresh = await refreshTurnMedia(turn)
  const taskId = await generateVideo({
    dramaId: loaded.session.dramaId,
    storyboardId,
    prompt: buildSceneVideoPrompt(state, turn.narrative),
    imageUrl: fresh.imageUrl || undefined,
    referenceMode: fresh.imageUrl ? 'first_frame' : 'reference',
    duration: 6,
    aspectRatio: '16:9',
    resolution: '720p',
  })
  await db.update(schema.rpgTurns).set({ videoTaskId: taskId, storyboardId }).where(eq(schema.rpgTurns.id, turn.id))
  return { task_id: taskId, status: 'processing' }
}

async function persistTurn(
  loaded: PlayContext,
  action: ResolvedAction,
  narrative: string,
  choices: RpgChoice[],
  state: RpgWorldState,
) {
  const ts = now()
  const turnIndex = loaded.turns.length + 1
  const screenplay = formatScreenplayScene(turnIndex, state, narrative, action.mode === 'opening' ? null : action.text)
  const res = await db.insert(schema.rpgTurns).values({
    sessionId: loaded.session.id,
    turnIndex,
    playerMode: action.mode,
    playerText: action.text || null,
    choiceId: action.choiceId,
    narrative,
    choices: JSON.stringify(choices),
    worldState: JSON.stringify(state),
    createdAt: ts,
  })
  const turnId = getInsertId(res)
  await db.update(schema.rpgSessions).set({
    worldState: JSON.stringify(state),
    turnCount: turnIndex,
    updatedAt: ts,
  }).where(eq(schema.rpgSessions.id, loaded.session.id))
  await appendManuscript(loaded.session.episodeId, turnIndex, action, narrative, screenplay)
  await syncDramaAssets(loaded, state)
  queueArticleContinuation(loaded.session.episodeId, loaded.session.dramaId)
  const [turn] = await db.select().from(schema.rpgTurns).where(eq(schema.rpgTurns.id, turnId))
  return turn
}

async function appendManuscript(
  episodeId: number,
  turnIndex: number,
  action: ResolvedAction,
  narrative: string,
  screenplay: string,
) {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode) return
  const playerLine = action.mode === 'opening' ? '' : `\n玩家：${action.text}`
  const content = `${episode.content || ''}\n\n【第${turnIndex}幕】${playerLine}\n${narrative}\n`
  const scriptContent = `${episode.scriptContent || ''}${episode.scriptContent ? '\n\n' : ''}${screenplay}`
  await db.update(schema.episodes).set({
    content,
    scriptContent,
    updatedAt: now(),
  }).where(eq(schema.episodes.id, episodeId))
}

function queueArticleContinuation(episodeId: number, dramaId: number) {
  void (async () => {
    const agent = mastra.getAgent('script_rewriter')
    if (!agent) return
    const requestContext = buildAgentRequestContext({ episodeId, dramaId })
    await agent.generate(
      [{
        role: 'user',
        content: '请读取当前集正文，把玩家已经经历的每一幕改写为格式化剧本，并调用 save_script 保存完整剧本。按幕的顺序保留情节，不要替玩家提前写结局。',
      }],
      { maxSteps: 8, requestContext },
    )
  })().catch(error => {
    console.error('[rpg] script_rewriter', error instanceof Error ? error.message : error)
  })
}

async function syncDramaAssets(loaded: PlayContext, state: RpgWorldState) {
  const ts = now()
  const dramaId = loaded.session.dramaId
  const episodeId = loaded.session.episodeId
  for (const character of state.characters) {
    const rows = await db.select().from(schema.characters).where(eq(schema.characters.dramaId, dramaId))
    const existing = rows.find(row => row.name === character.name && !row.deletedAt)
    let characterId = existing?.id
    if (existing) {
      await db.update(schema.characters).set({
        role: character.role || existing.role,
        description: character.status || existing.description,
        appearance: character.appearance || existing.appearance,
        updatedAt: ts,
      }).where(eq(schema.characters.id, existing.id))
    } else {
      const res = await db.insert(schema.characters).values({
        dramaId,
        name: character.name,
        role: character.role,
        description: character.status,
        appearance: character.appearance,
        createdAt: ts,
        updatedAt: ts,
      })
      characterId = getInsertId(res)
    }
    if (characterId) await linkEpisodeCharacter(episodeId, characterId, ts)
  }

  const sceneId = await upsertScene(dramaId, episodeId, state, ts)
  await linkEpisodeScene(episodeId, sceneId, ts)

  for (const item of state.items) {
    const rows = await db.select().from(schema.props).where(eq(schema.props.dramaId, dramaId))
    const existing = rows.find(row => row.name === item.name && !row.deletedAt)
    let propId = existing?.id
    if (existing) {
      await db.update(schema.props).set({
        description: item.description || existing.description,
        updatedAt: ts,
      }).where(eq(schema.props.id, existing.id))
    } else {
      const res = await db.insert(schema.props).values({
        dramaId,
        name: item.name,
        type: '关键物品',
        description: item.holder ? `${item.holder}持有。${item.description}` : item.description,
        createdAt: ts,
        updatedAt: ts,
      })
      propId = getInsertId(res)
    }
    if (propId) await linkEpisodeProp(episodeId, propId, ts)
  }
  return sceneId
}

async function ensureScene(loaded: PlayContext, turn: typeof schema.rpgTurns.$inferSelect) {
  if (turn.sceneId) return turn.sceneId
  const state = parseJson<RpgWorldState>(turn.worldState, loaded.state)
  return upsertScene(loaded.session.dramaId, loaded.session.episodeId, state, now())
}

async function upsertScene(dramaId: number, episodeId: number, state: RpgWorldState, ts: string) {
  const rows = await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId))
  const existing = rows.find(row => row.location === state.scene.location && row.time === state.scene.time && !row.deletedAt)
  const prompt = [state.scene.summary, state.scene.atmosphere].filter(Boolean).join('，') || state.scene.location
  if (existing) {
    await db.update(schema.scenes).set({
      prompt,
      lighting: state.scene.atmosphere || existing.lighting,
      episodeId,
      updatedAt: ts,
    }).where(eq(schema.scenes.id, existing.id))
    return existing.id
  }
  const res = await db.insert(schema.scenes).values({
    dramaId,
    episodeId,
    location: state.scene.location || '未知地点',
    time: state.scene.time || '此时',
    prompt,
    lighting: state.scene.atmosphere,
    createdAt: ts,
    updatedAt: ts,
  })
  return getInsertId(res)
}

async function ensureStoryboard(
  loaded: PlayContext,
  turn: typeof schema.rpgTurns.$inferSelect,
  state: RpgWorldState,
) {
  if (turn.storyboardId) return turn.storyboardId
  const ts = now()
  const sceneId = await ensureScene(loaded, turn)
  const res = await db.insert(schema.storyboards).values({
    episodeId: loaded.session.episodeId,
    sceneId,
    storyboardNumber: turn.turnIndex,
    title: state.scene.location,
    location: state.scene.location,
    time: state.scene.time,
    description: turn.narrative,
    atmosphere: state.scene.atmosphere,
    videoPrompt: buildSceneVideoPrompt(state, turn.narrative),
    duration: 6,
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  })
  const storyboardId = getInsertId(res)
  await db.update(schema.rpgTurns).set({ storyboardId, sceneId }).where(eq(schema.rpgTurns.id, turn.id))
  return storyboardId
}

async function linkEpisodeCharacter(episodeId: number, characterId: number, ts: string) {
  const [existing] = await db.select().from(schema.episodeCharacters).where(and(
    eq(schema.episodeCharacters.episodeId, episodeId),
    eq(schema.episodeCharacters.characterId, characterId),
  ))
  if (existing) return
  await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: ts })
}

async function linkEpisodeScene(episodeId: number, sceneId: number, ts: string) {
  const [existing] = await db.select().from(schema.episodeScenes).where(and(
    eq(schema.episodeScenes.episodeId, episodeId),
    eq(schema.episodeScenes.sceneId, sceneId),
  ))
  if (existing) return
  await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: ts })
}

async function linkEpisodeProp(episodeId: number, propId: number, ts: string) {
  const [existing] = await db.select().from(schema.episodeProps).where(and(
    eq(schema.episodeProps.episodeId, episodeId),
    eq(schema.episodeProps.propId, propId),
  ))
  if (existing) return
  await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: ts })
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
    return `第${turn.turnIndex}幕\n${player}${turn.narrative}`
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

function buildMessages(
  world: typeof schema.rpgWorlds.$inferSelect,
  state: RpgWorldState,
  recent: string,
  actionLine: string,
) {
  return [
    { role: 'system', content: NARRATOR_SYSTEM },
    {
      role: 'user',
      content: [
        `世界：${world.title}`,
        world.genre ? `类型：${world.genre}` : '',
        `设定：${world.premise}`,
        `当前状态：${JSON.stringify(state)}`,
        recent ? `最近剧情：\n${recent}` : '',
        actionLine,
      ].filter(Boolean).join('\n\n'),
    },
  ]
}

async function* streamNarration(messages: Array<{ role: string; content: string }>): AsyncGenerator<string> {
  const config = await getTextConfig()
  const url = joinChatUrl(getTextProviderBaseUrl(config))
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.85,
      max_tokens: 4096,
      stream: true,
      thinking: { type: 'disabled' },
      enable_thinking: false,
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(clipError(detail || `文本接口 ${response.status}`))
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let emitted = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const delta = readDelta(line)
      if (!delta) continue
      emitted = true
      yield delta
    }
  }
  const tail = readDelta(buffer)
  if (tail) {
    emitted = true
    yield tail
  }
  if (!emitted) throw new Error('文本接口没有返回内容')
}

function joinChatUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

function readDelta(line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return ''
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const json = JSON.parse(data)
    const content = json.choices?.[0]?.delta?.content
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

function clipError(message: string) {
  return message.replace(/\bsk-[\w-]+/g, '[redacted]').slice(0, 280)
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
  if (premise.length < 20) throw new Error('世界设定至少写 20 字，说书人才知道从哪写起')
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
    narrative: turn.narrative,
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
