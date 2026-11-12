import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptPlayerCharacter,
  fallbackPlayerCharacter,
  normalizeStoredPlayerCharacter,
  playerProfileFromDefaults,
  portraitFieldsChanged,
  withPlayerCharacterGuidance,
  type PlayerCharacterSnapshot,
} from '../src/services/rpg/player-character.ts'

const profile = playerProfileFromDefaults({
  name: '林雾',
  role: '医生',
  personality: '谨慎但富有同情心',
  values: '先救人',
  speech: '短句、少下判断',
  habits: '先洗手再问诊',
  desires: '找到失踪的老师',
  fears: '再次迟到',
  relationships: '记挂老师和邻居孩子',
  abilities: '外伤处理和辨认药材',
  background: '在边境诊所长大',
  styling: '深色风衣',
})

const character: PlayerCharacterSnapshot = {
  global_character_id: 7,
  project_character_id: 12,
  appearance: '短发，左眉有浅疤',
  physique: '高挑清瘦',
  ...profile,
  image_url: '/static/lin-wu.png',
  adapted: false,
}

test('world adaptation rewrites life details and preserves face and physique', () => {
  const adapted = adaptPlayerCharacter(character, `\`\`\`json
{"name":"阿雾","role":"边境医官","appearance":"不该被采用的外貌","physique":"不该被采用的身材","personality":"冷静果断","values":"完成任务优先","speech":"军中用语","habits":"睡前检查药箱","desires":"活过这个冬天","fears":"药物用尽","relationships":"只信任同营的护士","abilities":"战地止血","background":"被征召离开诊所","styling":"旧军医制服"}
\`\`\``)
  assert.equal(adapted.name, '阿雾')
  assert.equal(adapted.role, '边境医官')
  assert.equal(adapted.appearance, character.appearance)
  assert.equal(adapted.physique, character.physique)
  assert.equal(adapted.values, '完成任务优先')
  assert.equal(adapted.speech, '军中用语')
  assert.equal(adapted.habits, '睡前检查药箱')
  assert.equal(adapted.desires, '活过这个冬天')
  assert.equal(adapted.fears, '药物用尽')
  assert.equal(adapted.relationships, '只信任同营的护士')
  assert.equal(adapted.abilities, '战地止血')
  assert.equal(adapted.background, '被征召离开诊所')
  assert.equal(adapted.styling, '旧军医制服')
  assert.equal(adapted.default_name, '林雾')
  assert.equal(adapted.adapted, true)
})

test('missing adaptation fields and failed calls keep defaults', () => {
  const partial = adaptPlayerCharacter(character, '{"background":"旧城长大","values":42}')
  assert.equal(partial.personality, character.default_personality)
  assert.equal(partial.values, character.default_values)
  assert.equal(partial.styling, character.default_styling)
  assert.equal(partial.background, '旧城长大')
  assert.throws(() => adaptPlayerCharacter(character, 'not json'))
  const fallback = fallbackPlayerCharacter({ ...character, name: '临时名', values: '临时价值观', styling: '临时衣服' })
  assert.equal(fallback.name, character.default_name)
  assert.equal(fallback.values, character.default_values)
  assert.equal(fallback.styling, character.default_styling)
  assert.equal(fallback.appearance, character.appearance)
})

test('stored snapshots without new keys remain usable', () => {
  const legacy = normalizeStoredPlayerCharacter({
    global_character_id: 7,
    project_character_id: 12,
    name: '林雾',
    role: '医生',
    appearance: '短发',
    physique: '清瘦',
    default_personality: '谨慎',
    default_styling: '深色风衣',
    personality: '谨慎',
    background: '',
    styling: '深色风衣',
    image_url: '/static/lin-wu.png',
    adapted: false,
  } as PlayerCharacterSnapshot)
  assert.equal(legacy.default_name, '林雾')
  assert.equal(legacy.values, '')
  assert.equal(legacy.default_values, '')
  assert.equal(legacy.default_personality, '谨慎')
})

test('only face, physique, and clothing refresh a portrait', () => {
  assert.equal(portraitFieldsChanged(character, { ...character, values: '另一种价值观' }), false)
  assert.equal(portraitFieldsChanged(character, { ...character, styling: '旧军医制服' }), true)
  assert.equal(portraitFieldsChanged(character, { ...character, appearance: '长发' }), true)
  assert.equal(portraitFieldsChanged(character, { ...character, physique: '矮小' }), true)
})

test('player guidance lists the world life and keeps face and physique fixed', () => {
  const first = withPlayerCharacterGuidance('世界规则：不能撒谎', character)
  const next = withPlayerCharacterGuidance(first, { ...character, styling: '旧军医制服', name: '阿雾' })
  assert.equal(next.split('【玩家主角设定】').length - 1, 1)
  assert.match(next, /世界规则：不能撒谎/)
  assert.match(next, /本世界姓名：阿雾/)
  assert.match(next, /本世界价值观：先救人/)
  assert.match(next, /本世界服装与妆造：旧军医制服/)
  assert.match(next, /固定外貌：短发，左眉有浅疤/)
  assert.match(next, /固定身材：高挑清瘦/)
  assert.match(next, /始终保持脸部外貌和身材与固定设定一致/)
  assert.doesNotMatch(next, /始终保持姓名、身份/)
})
