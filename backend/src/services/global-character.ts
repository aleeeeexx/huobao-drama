import { completeNovelPrompt } from './novel/complete.js'
import { parseModelJson } from './novel/ai-novel-flow.js'

export interface GlobalCharacterDraft {
  name: string
  role: string
  appearance: string
  physique: string
  default_personality: string
  default_styling: string
  image_url: null
}

export interface WorldPlayerCharacterDraft {
  name: string
  role: string
  appearance: string
  physique: string
  personality: string
  background: string
  styling: string
}

export async function generateGlobalCharacterDraft(
  concept: unknown,
  complete: typeof completeNovelPrompt = completeNovelPrompt,
): Promise<GlobalCharacterDraft> {
  const brief = typeof concept === 'string' ? concept.trim().slice(0, 2000) : ''
  if (!brief) throw new Error('请先写下角色构想')
  const raw = await complete([
    '根据角色构想，设计一个可在不同世界复用的全局角色。姓名、身份、脸部外貌和身材是稳定特征；性格与服装是默认值，后续会按世界调整。',
    `角色构想：${brief}`,
    '返回 JSON 对象，字段为 name、role、appearance、physique、default_personality、default_styling，值均为简体中文字符串。不要返回 Markdown。',
  ].join('\n\n'), { timeoutMs: 45_000 })
  const fields = parseModelJson(raw)
  const draft = {
    name: textField(fields.name, 80),
    role: textField(fields.role, 120),
    appearance: textField(fields.appearance, 2000),
    physique: textField(fields.physique, 1200),
    default_personality: textField(fields.default_personality, 2000),
    default_styling: textField(fields.default_styling, 2000),
    image_url: null,
  }
  if (!draft.name) throw new Error('角色草稿缺少姓名，请重新生成')
  return draft
}

export async function generateWorldPlayerCharacterDraft(
  world: { title: string; genre?: string | null; premise: string },
  complete: typeof completeNovelPrompt = completeNovelPrompt,
): Promise<WorldPlayerCharacterDraft> {
  const raw = await complete([
    '请为互动故事生成一位本世界专属的玩家主角。让人物身份自然嵌入世界设定，提供可用于后续章节和角色定妆图的一致外貌。',
    `世界名称：${world.title}`,
    `世界类型：${world.genre || '原创'}`,
    `世界设定：${world.premise.slice(0, 2000)}`,
    '返回 JSON 对象，字段为 name、role、appearance、physique、personality、background、styling，值均为简体中文字符串。姓名应具体自然；外貌、身材、性格、经历和服装都要简洁具体。不要返回 Markdown。',
  ].join('\n\n'), { timeoutMs: 45_000 })
  const fields = parseModelJson(raw)
  const draft = {
    name: textField(fields.name, 80),
    role: textField(fields.role, 120),
    appearance: textField(fields.appearance, 2000),
    physique: textField(fields.physique, 1200),
    personality: textField(fields.personality, 2000),
    background: textField(fields.background, 2000),
    styling: textField(fields.styling, 2000),
  }
  if (!draft.name) throw new Error('本世界主角缺少姓名')
  return draft
}

export function fallbackWorldPlayerCharacterDraft(
  world: { title: string; genre?: string | null; premise: string },
): WorldPlayerCharacterDraft {
  const role = world.premise.match(/你是([^，。；]+)/)?.[1]?.trim() || '本世界的参与者'
  const name = world.premise.match(/(?:你叫|名为)([^，。；、]+)/)?.[1]?.trim() || '旅人'
  return {
    name: name.slice(0, 80),
    role: role.slice(0, 120),
    appearance: '尚未设定，可在本局主角编辑中补充。',
    physique: '',
    personality: '性格会随着你的选择逐渐显现。',
    background: world.premise.slice(0, 2000),
    styling: `符合${world.genre || '当前世界'}设定的日常装束。`,
  }
}

function textField(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}
