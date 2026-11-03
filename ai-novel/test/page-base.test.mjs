import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const match = html.match(/function mountPrefix\(\) \{[\s\S]*?\n    \}/)

function mountFor(pathname) {
  assert.ok(match, 'index.html should define mountPrefix')
  return vm.runInNewContext(`${match[0]}\nmountPrefix()`, { location: { pathname } })
}

test('ai-novel page keeps API calls under the mount path used by 织界', () => {
  assert.equal(mountFor('/'), '')
  assert.equal(mountFor('/index.html'), '')
  assert.equal(mountFor('/ai-novel-app/'), '/ai-novel-app')
  assert.equal(mountFor('/ai-novel-app/index.html'), '/ai-novel-app')
  assert.match(html, /fetch\(`\$\{mountPrefix\(\)\}\$\{path\}`/)
  assert.match(html, /fetch\(`\$\{mountPrefix\(\)\}\/api\/books\/\$\{id\}\/direction`/)
})
