import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const mediaSource = readFileSync(new URL('../app/composables/useMedia.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(mediaSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const context = { exports: {} }
vm.runInNewContext(compiled, context)
const { publicMediaUrl } = context.exports

test('global character portraits resolve local paths from the site root', () => {
  const base = 'http://localhost:3013/play/123'
  assert.equal(new URL(publicMediaUrl('static/images/avatar.png'), base).pathname, '/static/images/avatar.png')
  assert.equal(publicMediaUrl('/static/images/avatar.png'), '/static/images/avatar.png')
  assert.equal(publicMediaUrl('https://example.com/avatar.png'), 'https://example.com/avatar.png')
  assert.equal(publicMediaUrl(null), '')
})

test('global character selectors and previews use the normalized media address', () => {
  for (const path of ['../app/views/rpg/play.vue', '../app/pages/index.vue', '../app/pages/characters.vue']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const { template, scriptSetup } = parse(source).descriptor
    assert.match(scriptSetup.content, /import \{ publicMediaUrl \} from '~\/composables\/useMedia'/)
    assert.match(template.content, /:src="publicMediaUrl\(character\.image_url\)"/)
  }
})
