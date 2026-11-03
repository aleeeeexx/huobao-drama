/**
 * 本模块自己的书库，不写入织界的 SQLite，也不进入 RPG 对局。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parseCreateNovelInput, runCreateNovelFlow } from './flow.mjs'
import { completeChat } from './llm.mjs'

export function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'draft',
      user_idea TEXT NOT NULL,
      number_of_chapters INTEGER NOT NULL,
      words_per_chapter INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      document TEXT NOT NULL DEFAULT '{}',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  const running = new Set()

  function parseDocument(raw) {
    try {
      const parsed = JSON.parse(raw || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  function serialize(row) {
    const document = parseDocument(row.document)
    return {
      id: row.id,
      status: row.status,
      title: row.title || document.title || '',
      user_idea: row.user_idea,
      number_of_chapters: row.number_of_chapters,
      words_per_chapter: row.words_per_chapter,
      error: row.error || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      document,
    }
  }

  function getRow(id) {
    return db.prepare('SELECT * FROM books WHERE id = ?').get(id)
  }

  return {
    list() {
      const rows = db.prepare('SELECT * FROM books ORDER BY updated_at DESC LIMIT 20').all()
      return rows.map(row => {
        const book = serialize(row)
        return {
          id: book.id,
          status: book.status,
          title: book.title,
          user_idea: book.user_idea,
          genre: book.document.genre || '',
          number_of_chapters: book.number_of_chapters,
          updated_at: book.updated_at,
        }
      })
    },
    get(id) {
      if (!Number.isInteger(id) || id < 1) return null
      const row = getRow(id)
      return row ? serialize(row) : null
    },
    create(body) {
      const parsed = parseCreateNovelInput(body)
      if (!parsed.ok) throw new Error(parsed.message)
      const ts = new Date().toISOString()
      const result = db.prepare(`
        INSERT INTO books (status, user_idea, number_of_chapters, words_per_chapter, title, document, error, created_at, updated_at)
        VALUES ('draft', ?, ?, ?, '', '{}', '', ?, ?)
      `).run(parsed.input.userIdea, parsed.input.numberOfChapters, parsed.input.wordsPerChapter, ts, ts)
      return this.get(Number(result.lastInsertRowid))
    },
    async generate(id, onStep, complete = completeChat) {
      if (running.has(id)) throw new Error('正在生成，请稍候')
      const existing = this.get(id)
      if (!existing) throw new Error('这本书不存在')
      if (existing.status === 'ready') throw new Error('故事方向已经生成')
      running.add(id)
      const stamp = () => new Date().toISOString()
      try {
        db.prepare(`UPDATE books SET status = 'running', error = '', updated_at = ? WHERE id = ?`).run(stamp(), id)
        const document = await runCreateNovelFlow({
          userIdea: existing.user_idea,
          numberOfChapters: existing.number_of_chapters,
          wordsPerChapter: existing.words_per_chapter,
        }, complete, onStep)
        const title = typeof document.title === 'string' ? document.title : ''
        db.prepare(`UPDATE books SET status = 'ready', title = ?, document = ?, error = '', updated_at = ? WHERE id = ?`)
          .run(title, JSON.stringify(document), stamp(), id)
        return this.get(id)
      } catch (error) {
        const message = error instanceof Error ? error.message : '故事方向没有生成'
        db.prepare(`UPDATE books SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`).run(message, stamp(), id)
        throw error
      } finally {
        running.delete(id)
      }
    },
    close() {
      db.close()
    },
  }
}

export function defaultDbPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  return process.env.AI_NOVEL_DB || path.join(moduleDir, 'data', 'books.sqlite')
}
