import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptPlayerCharacter,
  fallbackPlayerCharacter,
  withPlayerCharacterGuidance,
  type PlayerCharacterSnapshot,
} from '../src/services/rpg/player-character.ts'

const character: PlayerCharacterSnapshot = {
  global_character_id: 7,
  project_character_id: 12,
  name: '林雾',
  role: '医生',
  appearance: '短发，左眉有浅疤',
  physique: '高挑清瘦',
  default_personality: '谨慎但富有同情心',
  default_styling: '深色风衣',
  personality: '谨慎但富有同情心',
  background: '',
  styling: '深色风衣',
  image_url: '/static/lin-wu.png',
  adapted: false,
}

test('world adaptation changes only personality, background, and styling', () => {
  const adapted = adaptPlayerCharacter(character, '```json\n{"personality":"冷静果断","background":"在边境诊所长大","styling":"旧军医制服"}\n```')
  assert.equal(adapted.name, character.name)
  assert.equal(adapted.appearance, character.appearance)
  assert.equal(adapted.physique, character.physique)
  assert.equal(adapted.personality, '冷静果断')
  assert.equal(adapted.background, '在边境诊所长大')
  assert.equal(adapted.styling, '旧军医制服')
  assert.equal(adapted.adapted, true)
})

test('missing fields and failed adaptation use global defaults', () => {
  const partial = adaptPlayerCharacter(character, '{"background":"旧城长大"}')
  assert.equal(partial.personality, character.default_personality)
  assert.equal(partial.styling, character.default_styling)
  assert.equal(partial.background, '旧城长大')
  assert.throws(() => adaptPlayerCharacter(character, 'not json'))
  assert.equal(fallbackPlayerCharacter(character).personality, character.default_personality)
})

test('player guidance replaces its previous snapshot and preserves world guidance', () => {
  const first = withPlayerCharacterGuidance('世界规则：不能撒谎', character)
  const next = withPlayerCharacterGuidance(first, { ...character, styling: '旧军医制服' })
  assert.equal(next.split('【玩家主角设定】').length - 1, 1)
  assert.match(next, /世界规则：不能撒谎/)
  assert.match(next, /本世界服装与妆造：旧军医制服/)
})
