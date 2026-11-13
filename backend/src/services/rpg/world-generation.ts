import { completeNovelPrompt } from '../novel/complete.js'
import { parseModelJson } from '../novel/ai-novel-flow.js'

export interface WorldDraft {
  title: string
  genre: string
  tagline: string
  premise: string
}

/** 只生成可编辑草稿；世界和对局由玩家确认后沿用 createSession 保存。 */
export async function generateWorldDraft(
  concept: unknown,
  complete: typeof completeNovelPrompt = completeNovelPrompt,
): Promise<WorldDraft> {
  const brief = typeof concept === 'string' ? concept.trim() : ''
  if (!brief) throw new Error('请先写下一句话世界创意')
  if (brief.length > 2000) throw new Error('世界创意请控制在 2000 字以内')

  const raw = await complete([
    '根据玩家的一句话创意，设计一个可供互动文字 RPG 开始游戏的原创世界。忠实保留创意中的背景、主题与关键要求，再补全具体细节。',
    `世界创意：${brief}`,
    '设定需要包含世界背景、关键规则、玩家身份、眼前的冲突和可以采取行动的线索。用第二人称描述玩家处境，为后续选择和自由行动留下空间，不提前决定玩家行动或写定结局。不要锁定玩家的姓名、外貌和身材，以便适配玩家选择的主角。',
    '返回 JSON 对象，只包含 title（世界名称，1–40 字）、genre（类型，1–20 字）、tagline（一句话简介，1–40 字）、premise（世界设定，建议 200–800 字，至少 20 字，最多 2000 字）。所有值均为简体中文字符串，不要返回 Markdown、角色档案或章节正文。',
  ].join('\n\n'), { timeoutMs: 45_000, maxTokens: 2048 })

  let fields: Record<string, unknown>
  try {
    fields = parseModelJson(raw)
  } catch {
    throw new Error('世界草稿格式有误，请重新生成')
  }

  return {
    title: draftText(fields.title, '世界名称', 1, 40),
    genre: draftText(fields.genre, '世界类型', 1, 20),
    tagline: draftText(fields.tagline, '世界简介', 1, 40),
    premise: draftText(fields.premise, '世界设定', 20, 2000),
  }
}

function draftText(value: unknown, label: string, min: number, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length < min || text.length > max) {
    throw new Error(`${label}不完整或长度不合要求，请重新生成`)
  }
  return text
}
