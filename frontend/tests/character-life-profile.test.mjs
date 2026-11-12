import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const library = readFileSync(new URL('../app/pages/characters.vue', import.meta.url), 'utf8')
const play = readFileSync(new URL('../app/views/rpg/play.vue', import.meta.url), 'utf8')

test('character library separates fixed identity from world-variable defaults', () => {
  assert.match(library, /跨世界不变/)
  assert.match(library, /进入世界后会改变/)
  for (const label of ['默认姓名', '默认身份', '默认性格', '默认价值观', '默认说话方式', '默认习惯', '默认愿望', '默认恐惧', '默认在乎的人', '默认能力', '默认经历', '默认服装']) {
    assert.match(library, new RegExp(label))
  }
  assert.match(library, /随世界变化/)
  assert.equal(library.includes('reference_images'), false)
})

test('play editor shows the world life and marks face and physique as fixed', () => {
  assert.match(play, /固定外貌<span class="change-tag">跨世界不变<\/span>/)
  assert.match(play, /固定身材<span class="change-tag">跨世界不变<\/span>/)
  for (const label of ['本世界姓名', '本世界身份', '本世界性格', '本世界价值观', '本世界说话方式', '本世界习惯', '本世界愿望', '本世界恐惧', '本世界在乎的人', '本世界能力', '本世界经历', '本世界服装与妆造']) {
    assert.match(play, new RegExp(label))
  }
})
