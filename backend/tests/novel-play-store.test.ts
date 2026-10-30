import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dbFile = path.join(os.tmpdir(), `novel-play-${process.pid}.sqlite3`)
process.env.SQLITE_PATH = dbFile

test('a novel book stays out of the rpg lobby and media waits for a written chapter', async () => {
  const { createNovelBook, getNovelBook, illustrateNovelChapter, listNovelBooks } = await import('../src/services/novel/play.ts')
  const { listSessions } = await import('../src/services/rpg/engine.ts')
  const { db, schema } = await import('../src/db/index.ts')
  const { eq } = await import('drizzle-orm')

  const created = await createNovelBook({
    title: '雾隐茶寮',
    topic: '雨夜的茶寮里，记者回来找一张没有署名的茶券。',
    genre: '悬疑',
    user_guidance: '保留茶券这条线。',
    number_of_chapters: 2,
    word_number: 800,
  })
  assert.ok(created)
  assert.equal(created?.user_guidance, '保留茶券这条线。')
  assert.equal(created?.user_guidance.includes('第一人称'), false)
  assert.equal(created?.number_of_chapters, 2)
  assert.equal(created?.word_number, 800)
  assert.equal(created?.architecture.generated, false)
  assert.equal(created?.chapters.length, 0)
  assert.equal(created?.blueprint_ready, false)

  const listed = await listNovelBooks()
  assert.equal(listed.some(item => item.id === created?.id), true)
  const rpg = await listSessions()
  assert.equal(rpg.some(item => item.id === created?.id), false)

  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, created?.episode_id || 0))
  assert.equal(episode?.scriptContent || '', '')
  assert.equal(episode?.content || '', '')

  await assert.rejects(
    () => illustrateNovelChapter(created?.id || 0, 1),
    /这一章还没写完/,
  )
  const loaded = await getNovelBook(created?.id || 0)
  assert.equal(loaded?.chapters.length, 0)

  fs.rmSync(dbFile, { force: true })
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbFile}${suffix}`, { force: true })
})
