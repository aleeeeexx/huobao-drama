import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shareOpening } from '../../frontend/app/utils/rpg-opening.ts'

test('shareOpening starts one opening for the same session and allows a later one', async () => {
  let started = 0
  const start = async () => {
    started += 1
    await Promise.resolve()
  }
  await Promise.all([
    shareOpening(7, start),
    shareOpening(7, start),
  ])
  assert.equal(started, 1)
  await shareOpening(7, start)
  assert.equal(started, 2)
  await shareOpening(8, start)
  assert.equal(started, 3)
})
