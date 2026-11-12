import { completeNovelPrompt } from './novel/complete.js'
import { parseModelJson } from './novel/ai-novel-flow.js'

export interface GlobalCharacterDraft {
  name: string
  role: string
  appearance: string
  physique: string
  default_personality: string
  default_values: string
  default_speech: string
  default_habits: string
  default_desires: string
  default_fears: string
  default_relationships: string
  default_abilities: string
  default_background: string
  default_styling: string
  image_url: null
}

export interface WorldPlayerCharacterDraft {
  name: string
  role: string
  appearance: string
  physique: string
  personality: string
  values: string
  speech: string
  habits: string
  desires: string
  fears: string
  relationships: string
  abilities: string
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
    '根据角色构想，设计一个可在不同世界复用的人。固定外貌和固定身材跨世界保持原样。姓名、身份、性格、价值观、说话方式、习惯、愿望、恐惧、在乎的人、能力、经历和服装是默认值，进入每个世界后会改写。',
    `角色构想：${brief}`,
    '返回 JSON 对象，字段为 name、role、appearance、physique、default_personality、default_values、default_speech、default_habits、default_desires、default_fears、default_relationships、default_abilities、default_background、default_styling，值均为简体中文字符串。不要返回 Markdown。',
  ].join('\n\n'), { timeoutMs: 45_000 })
  const fields = parseModelJson(raw)
  const draft = {
    name: textField(fields.name, 80),
    role: textField(fields.role, 120),
    appearance: textField(fields.appearance, 2000),
    physique: textField(fields.physique, 2000),
    default_personality: textField(fields.default_personality, 2000),
    default_values: textField(fields.default_values, 2000),
    default_speech: textField(fields.default_speech, 2000),
    default_habits: textField(fields.default_habits, 2000),
    default_desires: textField(fields.default_desires, 2000),
    default_fears: textField(fields.default_fears, 2000),
    default_relationships: textField(fields.default_relationships, 2000),
    default_abilities: textField(fields.default_abilities, 2000),
    default_background: textField(fields.default_background, 2000),
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
    '返回 JSON 对象，字段为 name、role、appearance、physique、personality、values、speech、habits、desires、fears、relationships、abilities、background、styling，值均为简体中文字符串。姓名应具体自然；外貌、身材、性格、经历和服装都要简洁具体。不要返回 Markdown。',
  ].join('\n\n'), { timeoutMs: 45_000 })
  const fields = parseModelJson(raw)
  const draft = {
    name: textField(fields.name, 80),
    role: textField(fields.role, 120),
    appearance: textField(fields.appearance, 2000),
    physique: textField(fields.physique, 2000),
    personality: textField(fields.personality, 2000),
    values: textField(fields.values, 2000),
    speech: textField(fields.speech, 2000),
    habits: textField(fields.habits, 2000),
    desires: textField(fields.desires, 2000),
    fears: textField(fields.fears, 2000),
    relationships: textField(fields.relationships, 2000),
    abilities: textField(fields.abilities, 2000),
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
    values: '',
    speech: '',
    habits: '',
    desires: '',
    fears: '',
    relationships: '',
    abilities: '',
    background: world.premise.slice(0, 2000),
    styling: `符合${world.genre || '当前世界'}设定的日常装束。`,
  }
}

function textField(value: unknown, limit: number) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}
