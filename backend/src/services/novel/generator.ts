/**
 * 幻书文章生成与续写。
 * 设定、章计划和续写对照私有 aleeeeexx/AI_NovelGenerator 的 main 快照。
 * 每次只规划当前要写的章节，正文用 write_chapter_by_ai；续写带上已保存的上一章。
 * 模型调用由调用方注入，走幻书已配置的文本模型。
 */
import {
  appendRenderedPlan,
  chapterPlan,
  chapterProse,
  generateNovelSetting,
  parseChapterPlans,
  renderPlanChapterPrompt,
  renderWriteChapterPrompt,
} from './ai-novel-flow.js'
import {
  architectureIncomplete,
  maxBlueprintChapter,
  settleNovelProject,
  type NovelProject,
} from './project.js'

export {
  architectureIncomplete,
  cleanResponse,
  createNovelProject,
  exportNovelToMarkdown,
  exportNovelToText,
  formatGenre,
  maxBlueprintChapter,
  NOVEL_DEFAULT_CHAPTER_COUNT,
  NOVEL_DEFAULT_WORD_NUMBER,
  NOVEL_MAX_TOKENS,
  parseChapterBlueprint,
  settleNovelProject,
} from './project.js'
export type { NovelChapterInfo, NovelProject } from './project.js'

export type NovelComplete = (prompt: string) => Promise<string>

export async function generateArchitecture(
  project: NovelProject,
  complete: NovelComplete,
  onPartial?: (project: NovelProject) => Promise<void> | void,
): Promise<NovelProject> {
  const current = settleNovelProject(project)
  if (!architectureIncomplete(current)) return current
  return generateNovelSetting(current, complete, onPartial)
}

export interface BlueprintGenerationOptions {
  /** 规划到这一章为止。缺省时只补当前还没有计划的下一章。 */
  throughChapter?: number
  onPartial?: (blueprint: string, project: NovelProject) => Promise<void> | void
}

/**
 * 按 plan_chapters_by_ai 补上尚未规划的章节，每次一章。
 * 不预先写完整本书的大纲。
 */
export async function generateChapterBlueprint(
  project: NovelProject,
  complete: NovelComplete,
  options: BlueprintGenerationOptions = {},
): Promise<string> {
  const next = settleNovelProject(project)
  const throughChapter = Math.min(
    options.throughChapter ?? maxBlueprintChapter(next.chapterBlueprint) + 1,
    next.numberOfChapters,
  )
  let blueprint = next.chapterBlueprint || ''
  let cursor = maxBlueprintChapter(blueprint) + 1
  while (cursor <= throughChapter) {
    const previous = { ...next, chapterBlueprint: blueprint }
    const planned = parseChapterPlans(await complete(renderPlanChapterPrompt(previous, cursor, previous.userGuidance || '')), 1)[0]
    if (!planned) throw new Error('章计划没有生成出来')
    blueprint = appendRenderedPlan(blueprint, cursor, planned)
    next.chapterBlueprint = blueprint
    next.blueprintGenerated = maxBlueprintChapter(blueprint) >= next.numberOfChapters
    await options.onPartial?.(blueprint, next)
    cursor += 1
  }
  return blueprint
}

/** 按 write_chapter_by_ai 写一章。没有这一章的计划时直接拒绝。 */
export async function generateChapterDraft(
  project: NovelProject,
  chapterNumber: number,
  complete: NovelComplete,
): Promise<string> {
  if (!chapterPlan(project, chapterNumber)) throw new Error(`章节 ${chapterNumber} 还没有计划`)
  return chapterProse(await complete(renderWriteChapterPrompt(project, chapterNumber, project.userGuidance || '')))
}

export interface NovelChapterProductionOptions {
  /** 保留参数。章计划不再按 max_tokens 分块。 */
  maxTokens?: number
  /**
   * 只注入这一章正文的用户指导。
   * 不写回项目，也不进入设定和章计划。
   */
  chapterUserGuidance?: string
  /** 正文交给玩家之前的整理。缺省则保留模型正文。 */
  normalizeChapterText?: (text: string) => string
  onProject?: (project: NovelProject) => Promise<void> | void
}

/**
 * 缺设定就走 create_novel_by_ai，缺这一章的计划就补一章，然后写正文。
 * 续写把上一章已保存正文放进本章上下文。正文短于目标字数时不再另起扩写。
 */
export async function produceNovelChapter(
  project: NovelProject,
  chapterNumber: number,
  complete: NovelComplete,
  options: NovelChapterProductionOptions = {},
): Promise<{ project: NovelProject; chapterText: string }> {
  let next = settleNovelProject({ ...project, chapters: { ...project.chapters } })
  const bookGuidance = project.userGuidance
  const persist = async () => {
    next = { ...next, userGuidance: bookGuidance }
    await options.onProject?.(next)
  }
  const normalize = options.normalizeChapterText ?? ((text: string) => text)

  if (architectureIncomplete(next)) {
    next = await generateArchitecture(next, complete, async (partial) => {
      next = settleNovelProject({ ...partial, chapters: { ...partial.chapters }, userGuidance: bookGuidance })
      await persist()
    })
    next = { ...next, userGuidance: bookGuidance }
    await persist()
  }

  if (maxBlueprintChapter(next.chapterBlueprint) < chapterNumber) {
    const blueprint = await generateChapterBlueprint(next, complete, {
      throughChapter: chapterNumber,
      onPartial: async (partialBlueprint, partial) => {
        next = { ...partial, chapterBlueprint: partialBlueprint, chapters: { ...next.chapters }, userGuidance: bookGuidance }
        await persist()
      },
    })
    next = {
      ...next,
      chapterBlueprint: blueprint,
      blueprintGenerated: maxBlueprintChapter(blueprint) >= next.numberOfChapters,
      userGuidance: bookGuidance,
    }
    await persist()
  } else if (!next.blueprintGenerated && maxBlueprintChapter(next.chapterBlueprint) >= next.numberOfChapters) {
    next = { ...next, blueprintGenerated: true }
    await persist()
  }

  const draftGuidance = options.chapterUserGuidance !== undefined ? options.chapterUserGuidance : bookGuidance
  const chapterText = normalize(await generateChapterDraft({ ...next, userGuidance: draftGuidance }, chapterNumber, complete))
  if (!chapterText.trim()) throw new Error('这一幕没有写完，请再试一次')
  const plan = chapterPlan(next, chapterNumber)
  next = {
    ...next,
    chapters: { ...next.chapters, [String(chapterNumber)]: chapterText },
    userGuidance: bookGuidance,
    characterState: plan?.endState || next.characterState,
  }
  await persist()
  return { project: next, chapterText }
}
