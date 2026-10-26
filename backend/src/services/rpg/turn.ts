/**
 * 织界回合的纯逻辑：玩家行动解析、叙事流拆分、世界状态合并。
 * 不访问数据库，方便单测。
 */

export const RPG_STATE_SENTINEL = '<<<RPG_STATE>>>'
const FREE_TEXT_MAX = 400

export interface RpgChoice {
  id: string
  label: string
  detail: string
}

export interface RpgCharacter {
  name: string
  role: string
  status: string
  appearance: string
}

export interface RpgItem {
  name: string
  holder: string
  description: string
}

export interface RpgQuest {
  title: string
  status: 'active' | 'done' | 'failed'
  detail: string
}

export interface RpgSceneState {
  location: string
  time: string
  summary: string
  atmosphere: string
}

export interface RpgWorldState {
  scene: RpgSceneState
  characters: RpgCharacter[]
  items: RpgItem[]
  quests: RpgQuest[]
  memory: string
}

export interface ResolvedAction {
  mode: 'opening' | 'choice' | 'free'
  text: string
  choiceId: string | null
}

export const FALLBACK_CHOICES: RpgChoice[] = [
  { id: 'c1', label: '仔细观察四周', detail: '先弄清眼前的局面' },
  { id: 'c2', label: '上前搭话', detail: '找最近的人问个明白' },
  { id: 'c3', label: '先撤一步', detail: '不打草惊蛇，换个角度' },
]

export function emptyWorldState(premise = ''): RpgWorldState {
  return {
    scene: {
      location: '起点',
      time: '此时',
      summary: clip(premise, 80),
      atmosphere: '',
    },
    characters: [],
    items: [],
    quests: [],
    memory: '',
  }
}

export function resolvePlayerAction(
  body: { mode?: unknown; choice_id?: unknown; choiceId?: unknown; text?: unknown },
  latestChoices: RpgChoice[] | null,
  hasTurns: boolean,
): { ok: true; action: ResolvedAction } | { ok: false; message: string } {
  const mode = String(body?.mode || '').trim()
  const choiceId = String(body?.choice_id ?? body?.choiceId ?? '').trim()
  const text = String(body?.text ?? '').trim()

  if (!hasTurns) {
    if (mode && mode !== 'opening') return { ok: false, message: '这一局还没有开场，请先开始故事' }
    return { ok: true, action: { mode: 'opening', text: '', choiceId: null } }
  }
  if (mode === 'opening') return { ok: false, message: '开场已经写过了' }

  if (mode === 'choice') {
    if (!choiceId) return { ok: false, message: '请选择一个剧情走向' }
    const matched = (latestChoices || []).find(choice => choice.id === choiceId)
    if (!matched) return { ok: false, message: '这个选项已经不在当前回合' }
    return { ok: true, action: { mode: 'choice', text: matched.label, choiceId } }
  }

  if (mode === 'free') {
    if (!text) return { ok: false, message: '写下你要做的事' }
    if (text.length > FREE_TEXT_MAX) return { ok: false, message: `行动请控制在 ${FREE_TEXT_MAX} 字以内` }
    return { ok: true, action: { mode: 'free', text, choiceId: null } }
  }

  return { ok: false, message: '请点选剧情走向，或写下你的行动' }
}

/** 把模型流式输出拆成「可展示的叙事」和「回合结束后的状态 JSON」 */
export class NarrativeStreamParser {
  private pending = ''
  private stateRaw = ''
  private inState = false
  narrative = ''

  push(chunk: string): string {
    if (!chunk) return ''
    if (this.inState) {
      this.stateRaw += chunk
      return ''
    }
    this.pending += chunk
    const marker = this.pending.indexOf(RPG_STATE_SENTINEL)
    if (marker === -1) {
      const hold = RPG_STATE_SENTINEL.length - 1
      if (this.pending.length <= hold) return ''
      const visible = this.pending.slice(0, this.pending.length - hold)
      this.pending = this.pending.slice(this.pending.length - hold)
      this.narrative += visible
      return visible
    }
    const visible = this.pending.slice(0, marker)
    this.narrative += visible
    this.stateRaw = this.pending.slice(marker + RPG_STATE_SENTINEL.length)
    this.pending = ''
    this.inState = true
    return visible
  }

  finish(): { narrative: string; stateRaw: string } {
    if (!this.inState) {
      const salvaged = salvageTrailingState(this.narrative + this.pending)
      this.narrative = salvaged.narrative
      this.stateRaw = salvaged.stateRaw
      this.pending = ''
    }
    return { narrative: this.narrative.trim(), stateRaw: this.stateRaw.trim() }
  }
}

export function salvageTrailingState(text: string): { narrative: string; stateRaw: string } {
  const marker = text.lastIndexOf('{')
  if (marker > 20) {
    const candidate = text.slice(marker)
    if (candidate.includes('"choices"') || candidate.includes('"scene"')) {
      return { narrative: text.slice(0, marker).trim(), stateRaw: candidate.trim() }
    }
  }
  return { narrative: text.trim(), stateRaw: '' }
}

export function parseStatePayload(raw: string, previous: RpgWorldState): { state: RpgWorldState; choices: RpgChoice[] } {
  const parsed = parseJsonObject(raw)
  const patch = normalizeStatePatch(parsed)
  return {
    state: mergeWorldState(previous, patch),
    choices: normalizeChoices(parsed?.choices),
  }
}

export function mergeWorldState(previous: RpgWorldState, patch: Partial<RpgWorldState>): RpgWorldState {
  return {
    scene: patch.scene ?? previous.scene,
    characters: patch.characters ?? previous.characters,
    items: patch.items ?? previous.items,
    quests: patch.quests ?? previous.quests,
    memory: patch.memory ?? previous.memory,
  }
}

export function formatScreenplayScene(
  turnIndex: number,
  state: RpgWorldState,
  narrative: string,
  playerText: string | null,
): string {
  const location = state.scene.location || '未知地点'
  const time = state.scene.time || '日'
  const interior = /室|屋|房|殿|舱|寮|店|栈|阁|厅/.test(location) ? '内景' : '外景'
  const action = playerText ? `（玩家行动）${playerText}\n\n` : ''
  return `## S${turnIndex} | ${interior} · ${location} | ${time}\n\n${action}${narrative.trim()}\n`
}

export function buildSceneImagePrompt(state: RpgWorldState, styleHint = ''): string {
  const people = state.characters
    .slice(0, 3)
    .map(character => `${character.name}（${character.appearance || character.role || '人物'}）`)
    .join('，')
  return [
    styleHint,
    `场景：${state.scene.location}，${state.scene.time}`,
    state.scene.summary,
    state.scene.atmosphere ? `光线与氛围：${state.scene.atmosphere}` : '',
    people ? `画面中的人物：${people}` : '',
    '单幅电影感插画，主体清晰，不要文字，不要水印，不要分镜格子',
  ].filter(Boolean).join('\n')
}

export function buildSceneVideoPrompt(state: RpgWorldState, narrative: string): string {
  const motion = clip(state.scene.summary || narrative, 180)
  return [
    `0-3秒：${state.scene.location}，${state.scene.atmosphere || '电影光'}，镜头缓慢推进，看清环境。`,
    `3-6秒：${motion}`,
  ].join('\n')
}

export function describeAction(action: ResolvedAction, choices: RpgChoice[]): string {
  if (action.mode === 'opening') return '请写下这一局的开场，把玩家放进世界。'
  if (action.mode === 'choice') {
    const matched = choices.find(choice => choice.id === action.choiceId)
    const detail = matched?.detail ? `（${matched.detail}）` : ''
    return `玩家选择了剧情走向：「${action.text}」${detail}`
  }
  return `玩家写下了自己的行动：「${action.text}」`
}

function normalizeChoices(value: unknown): RpgChoice[] {
  if (!Array.isArray(value)) return FALLBACK_CHOICES.map(choice => ({ ...choice }))
  const choices: RpgChoice[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = clip(String(record.label || record.text || ''), 18)
    if (!label) continue
    const id = clip(String(record.id || `c${choices.length + 1}`), 16) || `c${choices.length + 1}`
    choices.push({
      id,
      label,
      detail: clip(String(record.detail || record.hint || ''), 36),
    })
    if (choices.length === 3) break
  }
  if (choices.length < 2) return FALLBACK_CHOICES.map(choice => ({ ...choice }))
  return choices.map((choice, index) => ({ ...choice, id: choice.id || `c${index + 1}` }))
}

function normalizeStatePatch(value: unknown): Partial<RpgWorldState> {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const patch: Partial<RpgWorldState> = {}
  if (record.scene && typeof record.scene === 'object') {
    const scene = record.scene as Record<string, unknown>
    patch.scene = {
      location: clip(String(scene.location || '未知地点'), 40) || '未知地点',
      time: clip(String(scene.time || '此时'), 20) || '此时',
      summary: clip(String(scene.summary || ''), 160),
      atmosphere: clip(String(scene.atmosphere || ''), 80),
    }
  }
  if (Array.isArray(record.characters)) patch.characters = record.characters.slice(0, 8).map(normalizeCharacter).filter(item => item.name)
  if (Array.isArray(record.items)) patch.items = record.items.slice(0, 8).map(normalizeItem).filter(item => item.name)
  if (Array.isArray(record.quests)) patch.quests = record.quests.slice(0, 6).map(normalizeQuest).filter(item => item.title)
  if (typeof record.memory === 'string') patch.memory = clip(record.memory, 400)
  return patch
}

function normalizeCharacter(value: unknown): RpgCharacter {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    name: clip(String(record.name || ''), 20),
    role: clip(String(record.role || ''), 20),
    status: clip(String(record.status || ''), 40),
    appearance: clip(String(record.appearance || ''), 80),
  }
}

function normalizeItem(value: unknown): RpgItem {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    name: clip(String(record.name || ''), 20),
    holder: clip(String(record.holder || record.owner || ''), 20),
    description: clip(String(record.description || ''), 80),
  }
}

function normalizeQuest(value: unknown): RpgQuest {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const statusRaw = String(record.status || 'active')
  const status = statusRaw === 'done' || statusRaw === 'failed' ? statusRaw : 'active'
  return {
    title: clip(String(record.title || record.name || ''), 24),
    status,
    detail: clip(String(record.detail || ''), 80),
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function clip(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed
}
