/**
 * 织界里的独立小说创作。
 * 正文只走火宝小说原稿：架构（含角色状态）→ 整本大纲 → firstDraft/nextDraft → 字数不足则扩写 → 定稿。
 * 不把正文交给剧本改写，也不做可读性整理。剧情图和剧情视频复用织界已有的生图、生视频通道。
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, getInsertId, schema } from '../../db/index.js'
import { EXTRACT_TARGETS, runExtraction } from '../extraction.js'
import { filmSession, illustrateSession } from '../rpg/engine.js'
import { NOVEL_PLAY_KIND } from '../rpg/play-kind.js'
import { emptyWorldState, publicAssetPath, type RpgWorldState } from '../rpg/turn.js'
import { LIVE_ACTION_CINEMATIC_STYLE } from '../live-action-cinematic.js'
import { now } from '../../utils/response.js'
import { completeNovelPrompt } from './complete.js'
import {
  createNovelProject,
  exportNovelToText,
  maxBlueprintChapter,
  parseChapterBlueprint,
  architectureIncomplete,
  type NovelProject,
} from './generator.js'
import {
  parseChapterNote,
  parseNovelBookInput,
  writeOriginalChapter,
  type NovelWritePhase,
} from './play-flow.js'

const NOVEL_SCENE_LOCATION_MAX = 40
const NOVEL_SCENE_SUMMARY_MAX = 80

const writingBooks = new Set<number>()
const assetPrep = new Map<number, Promise<void>>()
const sceneEnsure = new Map<number, Promise<void>>()

export {
  chapterGuidanceForDraft,
  novelWritePhase,
  parseChapterNote,
  parseNovelBookInput,
  phaseForNovelPrompt,
  writeOriginalChapter,
} from './play-flow.js'

export async function listNovelBooks() {
  const rows = await db.select().from(schema.rpgSessions)
    .where(eq(schema.rpgSessions.playKind, NOVEL_PLAY_KIND))
    .orderBy(desc(schema.rpgSessions.updatedAt))
    .limit(20)
  const books = []
  for (const row of rows) {
    const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, row.worldId))
    const project = readNovelProject(row.novelState, world)
    books.push({
      id: row.id,
      title: row.title,
      genre: world?.genre || project.genre,
      topic: world?.premise || project.topic,
      written_chapters: row.turnCount || 0,
      number_of_chapters: project.numberOfChapters,
      updated_at: row.updatedAt,
    })
  }
  return books
}

export async function createNovelBook(body: unknown) {
  const parsed = parseNovelBookInput(body)
  if (!parsed.ok) throw new Error(parsed.message)
  const input = parsed.book
  const project = createNovelProject({
    title: input.title,
    topic: input.topic,
    genre: input.genre,
    userGuidance: input.userGuidance,
    numberOfChapters: input.numberOfChapters,
    wordNumber: input.wordNumber,
  })
  const ts = now()
  const worldRes = await db.insert(schema.rpgWorlds).values({
    slug: `novel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: input.title,
    tagline: '',
    premise: input.topic,
    genre: input.genre,
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    isPreset: false,
    createdAt: ts,
    updatedAt: ts,
  })
  const worldId = getInsertId(worldRes)
  const dramaRes = await db.insert(schema.dramas).values({
    title: input.title,
    description: input.topic,
    genre: input.genre,
    style: LIVE_ACTION_CINEMATIC_STYLE.value,
    aspectRatio: '16:9',
    status: 'active',
    metadata: JSON.stringify({ source: 'novel' }),
    createdAt: ts,
    updatedAt: ts,
  })
  const dramaId = getInsertId(dramaRes)
  const episodeRes = await db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: 1,
    title: '小说正文',
    content: '',
    scriptContent: '',
    description: input.userGuidance,
    status: 'draft',
    resolution: '720p',
    createdAt: ts,
    updatedAt: ts,
  })
  const episodeId = getInsertId(episodeRes)
  const sessionRes = await db.insert(schema.rpgSessions).values({
    worldId,
    dramaId,
    episodeId,
    title: input.title,
    status: 'active',
    playKind: NOVEL_PLAY_KIND,
    worldState: JSON.stringify(emptyWorldState(input.topic)),
    novelState: JSON.stringify(project),
    turnCount: 0,
    createdAt: ts,
    updatedAt: ts,
  })
  const bookId = getInsertId(sessionRes)
  await db.update(schema.dramas)
    .set({ metadata: JSON.stringify({ source: 'novel', book_id: bookId }) })
    .where(eq(schema.dramas.id, dramaId))
  return getNovelBook(bookId)
}

export async function getNovelBook(bookId: number) {
  const loaded = await loadNovel(bookId)
  if (!loaded) return null
  const turns = []
  for (const turn of loaded.turns) turns.push(await refreshTurnMedia(turn))
  return serializeBook(loaded.session, loaded.world, loaded.project, turns)
}

export async function writeNovelBookChapter(
  bookId: number,
  body: unknown,
  onPhase?: (phase: NovelWritePhase) => Promise<void> | void,
) {
  const note = parseChapterNote(readNote(body))
  if (!note.ok) throw new Error(note.message)
  if (writingBooks.has(bookId)) throw new Error('这一章还在写，请稍候')
  writingBooks.add(bookId)
  try {
    const loaded = await loadNovel(bookId)
    if (!loaded) throw new Error('这本书不存在')
    const chapterNumber = nextChapterNumber(loaded.project)
    if (chapterNumber > loaded.project.numberOfChapters) throw new Error('这本书的章节已经写完')
    if (loaded.turns.some(turn => turn.turnIndex === chapterNumber)) throw new Error('这一章已经写过了')
    const existing = loaded.project.chapters[String(chapterNumber)]?.trim()
    if (existing) {
      await persistChapterTurn(loaded, chapterNumber, existing, note.note)
      return getNovelBook(bookId)
    }
    const produced = await writeOriginalChapter(loaded.project, chapterNumber, completeNovelPrompt, {
      chapterNote: note.note,
      onPhase,
      onProject: async (partial) => {
        await saveNovelProject(bookId, partial)
      },
    })
    if (!produced.chapterText.trim()) throw new Error('这一章没有写完，请再试一次')
    await db.update(schema.episodes).set({
      content: exportNovelToText(produced.project),
      updatedAt: now(),
    }).where(eq(schema.episodes.id, loaded.session.episodeId))
    void prepareNovelAssets(loaded.session.episodeId, loaded.session.dramaId)
    await persistChapterTurn(loaded, chapterNumber, produced.chapterText, note.note, produced.project)
    return getNovelBook(bookId)
  } finally {
    writingBooks.delete(bookId)
  }
}

export async function illustrateNovelChapter(bookId: number, chapterNumber: number, force = false) {
  const loaded = await mustNovel(bookId)
  const turn = turnForChapter(loaded, chapterNumber)
  await ensureNovelScene(loaded, chapterNumber)
  return illustrateSession(bookId, { force, turnId: turn.id })
}

export async function filmNovelChapter(bookId: number, chapterNumber: number) {
  const loaded = await mustNovel(bookId)
  const turn = turnForChapter(loaded, chapterNumber)
  await ensureNovelScene(loaded, chapterNumber)
  return filmSession(bookId, { turnId: turn.id })
}

function readNote(body: unknown) {
  if (!body || typeof body !== 'object') return ''
  const source = body as Record<string, unknown>
  return source.guidance ?? source.note ?? source.user_guidance ?? ''
}

function nextChapterNumber(project: NovelProject) {
  const written = Object.keys(project.chapters)
    .map(Number)
    .filter(number => number > 0 && project.chapters[String(number)]?.trim())
  if (!written.length) return 1
  return Math.max(...written) + 1
}

async function persistChapterTurn(
  loaded: NovelContext,
  chapterNumber: number,
  chapterText: string,
  note: string,
  project: NovelProject = loaded.project,
) {
  const ts = now()
  const state = chapterWorldState(project, chapterNumber)
  const res = await db.insert(schema.rpgTurns).values({
    sessionId: loaded.session.id,
    turnIndex: chapterNumber,
    playerMode: 'chapter',
    playerText: note || null,
    choiceId: null,
    narrative: chapterText,
    choices: '[]',
    worldState: JSON.stringify(state),
    createdAt: ts,
  })
  await db.update(schema.rpgSessions).set({
    worldState: JSON.stringify(state),
    novelState: JSON.stringify(project),
    turnCount: chapterNumber,
    updatedAt: ts,
  }).where(eq(schema.rpgSessions.id, loaded.session.id))
  return getInsertId(res)
}

function chapterWorldState(project: NovelProject, chapterNumber: number): RpgWorldState {
  const info = parseChapterBlueprint(project.chapterBlueprint).find(item => item.number === chapterNumber)
  const state = emptyWorldState(project.topic)
  state.scene.location = (info?.title || `第${chapterNumber}章`).slice(0, NOVEL_SCENE_LOCATION_MAX)
  state.scene.summary = (info?.summary || '').slice(0, NOVEL_SCENE_SUMMARY_MAX)
  state.scene.time = '此时'
  return state
}

function ensureNovelScene(loaded: NovelContext, chapterNumber: number) {
  const episodeId = loaded.session.episodeId
  const current = sceneEnsure.get(episodeId)
  if (current) return current
  const job = ensureNovelSceneOnce(loaded, chapterNumber).finally(() => {
    sceneEnsure.delete(episodeId)
  })
  sceneEnsure.set(episodeId, job)
  return job
}

async function ensureNovelSceneOnce(loaded: NovelContext, chapterNumber: number) {
  if (await linkedSceneCount(loaded.session.dramaId, loaded.session.episodeId) > 0) return
  await prepareNovelAssets(loaded.session.episodeId, loaded.session.dramaId)
  if (await linkedSceneCount(loaded.session.dramaId, loaded.session.episodeId) > 0) return
  const info = parseChapterBlueprint(loaded.project.chapterBlueprint).find(item => item.number === chapterNumber)
  const location = (info?.title || `第${chapterNumber}章`).slice(0, NOVEL_SCENE_LOCATION_MAX)
  const ts = now()
  const sceneRes = await db.insert(schema.scenes).values({
    dramaId: loaded.session.dramaId,
    episodeId: loaded.session.episodeId,
    location,
    time: '此时',
    prompt: (info?.summary || location).slice(0, NOVEL_SCENE_SUMMARY_MAX),
    status: 'pending',
    createdAt: ts,
    updatedAt: ts,
  })
  await db.insert(schema.episodeScenes).values({
    episodeId: loaded.session.episodeId,
    sceneId: getInsertId(sceneRes),
    createdAt: ts,
  })
}

function prepareNovelAssets(episodeId: number, dramaId: number) {
  const current = assetPrep.get(episodeId)
  if (current) return current
  const job = Promise.all(EXTRACT_TARGETS.map(target => runExtraction(episodeId, dramaId, target).catch(error => {
    console.error('[novel] extractor', error instanceof Error ? error.message : error)
  }))).then(() => undefined).finally(() => {
    assetPrep.delete(episodeId)
  })
  assetPrep.set(episodeId, job)
  return job
}

async function linkedSceneCount(dramaId: number, episodeId: number) {
  const links = await db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId))
  if (!links.length) return 0
  const ids = new Set(links.map(link => link.sceneId))
  const scenes = await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId, dramaId))
  return scenes.filter(scene => ids.has(scene.id) && !scene.deletedAt).length
}

async function saveNovelProject(bookId: number, project: NovelProject) {
  await db.update(schema.rpgSessions).set({
    novelState: JSON.stringify(project),
    updatedAt: now(),
  }).where(and(eq(schema.rpgSessions.id, bookId), eq(schema.rpgSessions.playKind, NOVEL_PLAY_KIND)))
}

function readNovelProject(
  raw: string | null | undefined,
  world?: { title: string; premise: string; genre: string | null } | null,
): NovelProject {
  const seed = createNovelProject({
    title: world?.title || '未命名',
    topic: world?.premise || '',
    genre: world?.genre || '其他',
  })
  if (!raw) return seed
  try {
    const parsed = JSON.parse(raw) as Partial<NovelProject>
    if (!parsed || typeof parsed !== 'object') return seed
    return {
      ...seed,
      ...parsed,
      chapters: parsed.chapters && typeof parsed.chapters === 'object' ? parsed.chapters : {},
      userGuidance: typeof parsed.userGuidance === 'string' ? parsed.userGuidance : seed.userGuidance,
      numberOfChapters: parsed.numberOfChapters || seed.numberOfChapters,
      wordNumber: parsed.wordNumber || seed.wordNumber,
    }
  } catch {
    return seed
  }
}

interface NovelContext {
  session: typeof schema.rpgSessions.$inferSelect
  world: typeof schema.rpgWorlds.$inferSelect
  project: NovelProject
  turns: Array<typeof schema.rpgTurns.$inferSelect>
}

async function loadNovel(bookId: number): Promise<NovelContext | null> {
  const [session] = await db.select().from(schema.rpgSessions).where(eq(schema.rpgSessions.id, bookId))
  if (!session || session.playKind !== NOVEL_PLAY_KIND) return null
  const [world] = await db.select().from(schema.rpgWorlds).where(eq(schema.rpgWorlds.id, session.worldId))
  if (!world) return null
  const turns = await db.select().from(schema.rpgTurns)
    .where(eq(schema.rpgTurns.sessionId, bookId))
    .orderBy(asc(schema.rpgTurns.turnIndex))
  return {
    session,
    world,
    project: readNovelProject(session.novelState, world),
    turns,
  }
}

async function mustNovel(bookId: number) {
  const loaded = await loadNovel(bookId)
  if (!loaded) throw new Error('这本书不存在')
  return loaded
}

function turnForChapter(loaded: NovelContext, chapterNumber: number) {
  const turn = loaded.turns.find(item => item.turnIndex === chapterNumber)
  if (!turn) throw new Error('这一章还没写完')
  return turn
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

function serializeBook(
  session: typeof schema.rpgSessions.$inferSelect,
  world: typeof schema.rpgWorlds.$inferSelect,
  project: NovelProject,
  turns: Array<typeof schema.rpgTurns.$inferSelect & {
    imageTask?: typeof schema.sysTask.$inferSelect | null
    videoTask?: typeof schema.sysTask.$inferSelect | null
  }>,
) {
  const blueprint = parseChapterBlueprint(project.chapterBlueprint)
  const turnByChapter = new Map(turns.map(turn => [turn.turnIndex, turn]))
  const numbers = Object.keys(project.chapters)
    .map(Number)
    .filter(number => number > 0 && project.chapters[String(number)]?.trim())
    .sort((left, right) => left - right)
  return {
    id: session.id,
    title: project.title || session.title,
    topic: project.topic || world.premise,
    genre: Array.isArray(project.genre) ? project.genre.join(' / ') : (project.genre || world.genre),
    user_guidance: project.userGuidance || '',
    word_number: project.wordNumber,
    number_of_chapters: project.numberOfChapters,
    drama_id: session.dramaId,
    episode_id: session.episodeId,
    writing: writingBooks.has(session.id),
    architecture: {
      generated: !architectureIncomplete(project),
      core_seed: project.coreSeed || '',
      character_dynamics: project.characterDynamics || '',
      character_state: project.characterState || '',
      world_building: project.worldBuilding || '',
      plot_architecture: project.plotArchitecture || '',
    },
    blueprint: project.chapterBlueprint || '',
    blueprint_ready: maxBlueprintChapter(project.chapterBlueprint) >= project.numberOfChapters,
    outline: blueprint.map(item => ({
      number: item.number,
      title: item.title,
      summary: item.summary,
      written: numbers.includes(item.number),
    })),
    chapters: numbers.map(number => {
      const info = blueprint.find(item => item.number === number)
      const turn = turnByChapter.get(number)
      const imageTask = turn?.imageTask
      const videoTask = turn?.videoTask
      return {
        number,
        title: info?.title || `第${number}章`,
        text: project.chapters[String(number)] || '',
        note: turn?.playerText || '',
        turn_id: turn?.id ?? null,
        image_url: publicAssetPath(turn?.imageUrl),
        video_url: publicAssetPath(turn?.videoUrl),
        image_status: imageTask?.status || (turn?.imageUrl ? 'completed' : null),
        video_status: videoTask?.status || (turn?.videoUrl ? 'completed' : null),
        image_error: imageTask?.status === 'failed' ? imageTask.errorMsg : null,
        video_error: videoTask?.status === 'failed' ? videoTask.errorMsg : null,
      }
    }),
  }
}
