export interface PlayerCharacterSnapshot {
  global_character_id: number | null
  project_character_id: number
  name: string
  role: string
  appearance: string
  physique: string
  default_name: string
  default_role: string
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
  image_url: string
  adapted: boolean
  /** 新世界的全局主角以参考图锁定身份，独立生成本局妆造。 */
  world_portrait_identity?: boolean
}

export const PLAYER_PROFILE_FIELDS = [
  { world: 'name', fallback: 'default_name', guidance: '本世界姓名' },
  { world: 'role', fallback: 'default_role', guidance: '本世界身份' },
  { world: 'personality', fallback: 'default_personality', guidance: '本世界性格' },
  { world: 'values', fallback: 'default_values', guidance: '本世界价值观' },
  { world: 'speech', fallback: 'default_speech', guidance: '本世界说话方式' },
  { world: 'habits', fallback: 'default_habits', guidance: '本世界习惯' },
  { world: 'desires', fallback: 'default_desires', guidance: '本世界愿望' },
  { world: 'fears', fallback: 'default_fears', guidance: '本世界恐惧' },
  { world: 'relationships', fallback: 'default_relationships', guidance: '本世界在乎的人' },
  { world: 'abilities', fallback: 'default_abilities', guidance: '本世界能力' },
  { world: 'background', fallback: 'default_background', guidance: '本世界经历' },
  { world: 'styling', fallback: 'default_styling', guidance: '本世界服装与妆造' },
] as const

type ProfileWorldKey = typeof PLAYER_PROFILE_FIELDS[number]['world']
type ProfileFallbackKey = typeof PLAYER_PROFILE_FIELDS[number]['fallback']
type PlayerProfile = Pick<PlayerCharacterSnapshot, ProfileWorldKey | ProfileFallbackKey>

export function playerProfileFromDefaults(
  worldValues: Partial<Record<ProfileWorldKey, string>>,
  defaults: Partial<Record<ProfileWorldKey, string>> = worldValues,
): PlayerProfile {
  const profile = {} as PlayerProfile
  for (const field of PLAYER_PROFILE_FIELDS) {
    const fallback = stringValue(defaults[field.world], '')
    profile[field.fallback] = fallback
    profile[field.world] = stringValue(worldValues[field.world], fallback)
  }
  return profile
}

export function normalizeStoredPlayerCharacter(value: PlayerCharacterSnapshot): PlayerCharacterSnapshot {
  const stored = value || {} as PlayerCharacterSnapshot
  const text = (key: keyof PlayerCharacterSnapshot) => typeof stored[key] === 'string' ? stored[key] as string : ''
  const profile = {} as PlayerProfile
  for (const field of PLAYER_PROFILE_FIELDS) {
    const current = text(field.world)
    profile[field.world] = current
    profile[field.fallback] = typeof stored[field.fallback] === 'string' ? stored[field.fallback] as string : current
  }
  return {
    global_character_id: typeof stored.global_character_id === 'number' ? stored.global_character_id : null,
    project_character_id: stored.project_character_id,
    appearance: text('appearance'),
    physique: text('physique'),
    ...profile,
    image_url: text('image_url'),
    adapted: stored.adapted === true,
    world_portrait_identity: stored.world_portrait_identity === true,
  }
}

export function adaptPlayerCharacter(character: PlayerCharacterSnapshot, response: string, strict = false): PlayerCharacterSnapshot {
  const current = normalizeStoredPlayerCharacter(character)
  const result = parseModelObject(response)
  if (strict && PLAYER_PROFILE_FIELDS.some(field => typeof result[field.world] !== 'string' || !(result[field.world] as string).trim())) {
    throw new Error('主角适配结果不完整')
  }
  const adapted: PlayerCharacterSnapshot = { ...current, adapted: true }
  for (const field of PLAYER_PROFILE_FIELDS) {
    adapted[field.world] = stringValue(result[field.world], current[field.fallback])
  }
  return adapted
}

export function fallbackPlayerCharacter(character: PlayerCharacterSnapshot): PlayerCharacterSnapshot {
  const current = normalizeStoredPlayerCharacter(character)
  const fallback: PlayerCharacterSnapshot = { ...current, adapted: true }
  for (const field of PLAYER_PROFILE_FIELDS) fallback[field.world] = current[field.fallback]
  return fallback
}

export function portraitFieldsChanged(
  previous: Pick<PlayerCharacterSnapshot, 'appearance' | 'physique' | 'styling'>,
  next: Pick<PlayerCharacterSnapshot, 'appearance' | 'physique' | 'styling'>,
) {
  return previous.appearance !== next.appearance
    || previous.physique !== next.physique
    || previous.styling !== next.styling
}

export function normalizePlayerCharacterField(value: unknown, fallback: string) {
  return stringValue(value, fallback)
}

export function withPlayerCharacterGuidance(guidance: string, character: PlayerCharacterSnapshot) {
  const current = normalizeStoredPlayerCharacter(character)
  const marker = '【玩家主角设定】'
  const base = guidance.split(marker)[0].trim()
  return [
    base,
    marker,
    ...PLAYER_PROFILE_FIELDS.map(field => `${field.guidance}：${current[field.world]}`),
    `固定外貌：${current.appearance}`,
    `固定身材：${current.physique}`,
    '始终保持脸部外貌和身材与固定设定一致。姓名、身份和生活细节使用本世界版本。行为体现本世界性格、价值观、习惯、愿望、恐惧、关系和经历。画面造型使用本世界服装。',
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
