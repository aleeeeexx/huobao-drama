/**
 * 小说创作页的纯逻辑。不访问数据库，方便单测。
 * 写章只调用火宝小说的 produceNovelChapter，不整理正文，也不改提示词。
 */
import {
  architectureIncomplete,
  maxBlueprintChapter,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  NOVEL_MAX_TOKENS,
  produceNovelChapter,
  type NovelComplete,
  type NovelProject,
} from './generator.js'

export const NOVEL_PLAY_TITLE_MAX = 40
export const NOVEL_PLAY_TOPIC_MIN = 2
export const NOVEL_PLAY_TOPIC_MAX = 2000
export const NOVEL_PLAY_GENRE_MAX = 20
export const NOVEL_PLAY_GUIDANCE_MAX = 2000
export const NOVEL_PLAY_CHAPTER_NOTE_MAX = 500
export const NOVEL_PLAY_CHAPTERS_MIN = 1
export const NOVEL_PLAY_CHAPTERS_MAX = 200
export const NOVEL_PLAY_WORDS_MIN = 200
export const NOVEL_PLAY_WORDS_MAX = 8000

export type NovelWritePhase = 'architecture' | 'blueprint' | 'draft' | 'enrich' | 'finalize'

export function phaseForNovelPrompt(prompt: string): NovelWritePhase | null {
  const text = prompt.trimStart()
  const head = text.slice(0, 80)
  const secondLine = text.split('\n')[1] || ''
  if (head.startsWith('以下章节文本较短')) return 'enrich'
  if (head.startsWith('以下是新完成的章节文本')) return 'finalize'
  if (head.startsWith('即将创作：') || head.startsWith('参考文档：')) return 'draft'
  if (head.startsWith('作为专业作家')) return 'architecture'
  if (head.startsWith('依据当前角色动力学设定')) return 'architecture'
  if (text.startsWith('基于以下元素') && secondLine.includes('小说类型')) return 'architecture'
  if (text.startsWith('基于以下元素') && secondLine.includes('内容指导')) return 'blueprint'
  return null
}

export function novelWritePhase(project: NovelProject, chapterNumber: number): NovelWritePhase {
  if (architectureIncomplete(project)) return 'architecture'
  if (maxBlueprintChapter(project.chapterBlueprint) < project.numberOfChapters) return 'blueprint'
  if (!project.chapters[String(chapterNumber)]?.trim()) return 'draft'
  return 'finalize'
}

/** 本章额外提示只并进这一章草稿的用户指导。空白时沿用起书时的指导，不替换提示词。 */
export function chapterGuidanceForDraft(bookGuidance: string, chapterNote: string): string | undefined {
  const note = chapterNote.trim()
  if (!note) return undefined
  return [bookGuidance.trim(), note].filter(Boolean).join('\n\n')
}

export interface NovelBookInput {
  title: string
  topic: string
  genre: string
  userGuidance: string
  numberOfChapters: number
  wordNumber: number
}

export function parseNovelBookInput(body: unknown): { ok: true; book: NovelBookInput } | { ok: false; message: string } {
  const source = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const title = String(source.title ?? '').trim()
  const topic = String(source.topic ?? source.premise ?? '').trim()
  const genre = String(source.genre ?? '').trim()
  const userGuidance = String(source.user_guidance ?? source.userGuidance ?? '').trim()
  if (!title) return { ok: false, message: '给这本书起个名字' }
  if (title.length > NOVEL_PLAY_TITLE_MAX) return { ok: false, message: `书名请控制在 ${NOVEL_PLAY_TITLE_MAX} 字以内` }
  if (topic.length < NOVEL_PLAY_TOPIC_MIN) return { ok: false, message: '写下这本书的主题' }
  if (topic.length > NOVEL_PLAY_TOPIC_MAX) return { ok: false, message: `主题请控制在 ${NOVEL_PLAY_TOPIC_MAX} 字以内` }
  if (genre.length > NOVEL_PLAY_GENRE_MAX) return { ok: false, message: `类型请控制在 ${NOVEL_PLAY_GENRE_MAX} 字以内` }
  if (userGuidance.length > NOVEL_PLAY_GUIDANCE_MAX) return { ok: false, message: `内容指导请控制在 ${NOVEL_PLAY_GUIDANCE_MAX} 字以内` }
  const numberOfChapters = readBoundedInt(
    source.number_of_chapters ?? source.numberOfChapters,
    NOVEL_DEFAULT_CHAPTER_COUNT,
    NOVEL_PLAY_CHAPTERS_MIN,
    NOVEL_PLAY_CHAPTERS_MAX,
    '章节数',
  )
  if (typeof numberOfChapters !== 'number') return numberOfChapters
  const wordNumber = readBoundedInt(
    source.word_number ?? source.wordNumber,
    NOVEL_DEFAULT_WORD_NUMBER,
    NOVEL_PLAY_WORDS_MIN,
    NOVEL_PLAY_WORDS_MAX,
    '每章字数',
  )
  if (typeof wordNumber !== 'number') return wordNumber
  return {
    ok: true,
    book: {
      title,
      topic,
      genre: genre || '其他',
      userGuidance,
      numberOfChapters,
      wordNumber,
    },
  }
}

export function parseChapterNote(value: unknown): { ok: true; note: string } | { ok: false; message: string } {
  const note = String(value ?? '').trim()
  if (note.length > NOVEL_PLAY_CHAPTER_NOTE_MAX) {
    return { ok: false, message: `本章提示请控制在 ${NOVEL_PLAY_CHAPTER_NOTE_MAX} 字以内` }
  }
  return { ok: true, note }
}

function readBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number | { ok: false; message: string } {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message: `${label}需要是 ${min} 到 ${max} 的整数` }
  }
  return parsed
}

export interface WriteOriginalChapterOptions {
  maxTokens?: number
  chapterNote?: string
  onPhase?: (phase: NovelWritePhase) => Promise<void> | void
  onProject?: (project: NovelProject) => Promise<void> | void
}

/**
 * 按火宝小说写一章。缺架构就补到角色状态和情节，缺大纲就写满全书，再草稿、扩写、定稿。
 * 不传入正文整理函数，模型返回的原稿原样留下。
 */
export async function writeOriginalChapter(
  project: NovelProject,
  chapterNumber: number,
  complete: NovelComplete,
  options: WriteOriginalChapterOptions = {},
): Promise<{ project: NovelProject; chapterText: string }> {
  const chapterUserGuidance = chapterGuidanceForDraft(project.userGuidance, options.chapterNote || '')
  return produceNovelChapter(project, chapterNumber, async (prompt) => {
    const phase = phaseForNovelPrompt(prompt)
    if (phase) await options.onPhase?.(phase)
    return complete(prompt)
  }, {
    maxTokens: options.maxTokens ?? NOVEL_MAX_TOKENS,
    ...(chapterUserGuidance !== undefined ? { chapterUserGuidance } : {}),
    onProject: async (partial) => {
      await options.onPhase?.(novelWritePhase(partial, chapterNumber))
      await options.onProject?.(partial)
    },
  })
}
