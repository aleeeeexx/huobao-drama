export interface PlayerCharacterSnapshot {
  global_character_id: number | null
  project_character_id: number
  name: string
  role: string
  appearance: string
  physique: string
  default_personality: string
  default_styling: string
  personality: string
  background: string
  styling: string
  image_url: string
  adapted: boolean
}

export function adaptPlayerCharacter(character: PlayerCharacterSnapshot, response: string): PlayerCharacterSnapshot {
  const result = parseModelObject(response)
  return {
    ...character,
    personality: stringValue(result.personality, character.default_personality),
    background: stringValue(result.background, ''),
    styling: stringValue(result.styling, character.default_styling),
    adapted: true,
  }
}

export function fallbackPlayerCharacter(character: PlayerCharacterSnapshot): PlayerCharacterSnapshot {
  return {
    ...character,
    personality: character.default_personality,
    background: '',
    styling: character.default_styling,
    adapted: true,
  }
}

export function normalizePlayerCharacterField(value: unknown, fallback: string) {
  return stringValue(value, fallback)
}

export function withPlayerCharacterGuidance(guidance: string, character: PlayerCharacterSnapshot) {
  const marker = '【玩家主角设定】'
  const base = guidance.split(marker)[0].trim()
  return [
    base,
    marker,
    `姓名：${character.name}`,
    `身份：${character.role}`,
    `固定外貌：${character.appearance}`,
    `固定身材：${character.physique}`,
    `本世界性格：${character.personality}`,
    `本世界背景经历：${character.background}`,
    `本世界服装与妆造：${character.styling}`,
    '始终保持姓名、身份、脸部外貌和身材一致；行为体现本世界性格和背景；画面造型使用本世界服装。',
  ].filter(Boolean).join('\n')
}

function parseModelObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('主角适配没有返回 JSON')
  const parsed = JSON.parse(cleaned.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('主角适配结果无效')
  return parsed as Record<string, unknown>
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === 'string' ? value.trim().slice(0, 4000) : fallback
}
