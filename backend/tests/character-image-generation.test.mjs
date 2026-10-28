import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('character image generation uses 16:9 asset size', () => {
  const source = read('src/services/asset-images.ts')
  const route = read('src/routes/characters.ts')

  assert.match(source, /CHARACTER_IMAGE_SIZE = '1920x1080'/)
  assert.match(source, /16:9 横版角色定妆照/)
  assert.match(source, /半身角色海报构图/)
  assert.match(source, /size: CHARACTER_IMAGE_SIZE/)
  assert.match(route, /enqueueAssetReferenceImage\('character'/)
  assert.match(read('src/routes/scenes.ts'), /enqueueAssetReferenceImage\('scene'/)
  assert.match(read('src/routes/props.ts'), /enqueueAssetReferenceImage\('prop'/)
  assert.match(source, /画面中没有任何人物，空场景，只有场景本身/)
})
