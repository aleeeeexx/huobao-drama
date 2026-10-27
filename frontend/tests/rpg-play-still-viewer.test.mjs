import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/views/rpg/play.vue', import.meta.url), 'utf8')

test('story still is a keyboard-accessible control and the sidebar thumb stays cropped', () => {
  const figure = page.match(/<figure v-if="latest\?\.image_url" class="still">[\s\S]*?<\/figure>/)
  assert.ok(figure, 'sidebar still figure')
  assert.match(figure[0], /class="still-open"/)
  assert.match(figure[0], /type="button"/)
  assert.match(figure[0], /@click="openStill"/)
  assert.match(figure[0], /alt="这一幕的剧情图"/)
  assert.doesNotMatch(figure[0], /still-viewer/)

  const style = page.slice(page.indexOf('<style'))
  assert.match(style, /\.still img, \.clip \{[^}]*max-height:\s*180px[^}]*object-fit:\s*cover/)
  assert.match(style, /\.still-open \{[^}]*cursor:\s*zoom-in/)
  assert.match(style, /\.still-open:focus-visible \{/)
})

test('clicking the story still opens a viewport lightbox that contains the full image', () => {
  assert.match(page, /<Teleport to="body">/)
  assert.match(page, /class="overlay still-viewer"/)
  assert.match(page, /role="dialog"/)
  assert.match(page, /aria-modal="true"/)
  assert.match(page, /aria-label="这一幕的剧情图"/)
  assert.match(page, /@click\.self="closeStill"/)
  assert.match(page, /class="still-viewer-img"/)
  assert.match(page, /function openStill\(/)
  assert.match(page, /function closeStill\(/)
  assert.match(page, /event\.key !== 'Escape'/)

  const viewer = page.match(/<Teleport to="body">[\s\S]*?<\/Teleport>/)
  assert.ok(viewer, 'lightbox teleport')
  assert.match(viewer[0], /class="still-viewer-img"/)
  assert.doesNotMatch(viewer[0], /object-fit:\s*cover/)
  assert.doesNotMatch(viewer[0], /max-height:\s*180px/)

  const style = page.slice(page.indexOf('<style'))
  const viewerImg = style.match(/\.still-viewer-img \{[^}]*\}/)
  assert.ok(viewerImg, 'viewer image rule')
  assert.match(viewerImg[0], /object-fit:\s*contain/)
  assert.match(viewerImg[0], /max-width:\s*calc\(100vw - \(var\(--still-viewer-pad-x\) \* 2\)\)/)
  assert.match(viewerImg[0], /max-height:\s*calc\(100dvh - var\(--still-viewer-pad-top\) - var\(--still-viewer-pad-bottom\)\)/)
  assert.doesNotMatch(viewerImg[0], /object-fit:\s*cover/)
  assert.doesNotMatch(viewerImg[0], /max-height:\s*180px/)
})
