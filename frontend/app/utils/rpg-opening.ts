/**
 * 同一局的开场请求只发出一次。
 * 播放页若被挂上两次,第二次等待这一次结束再自己刷新,
 * 避免两个开场都失败、连续弹出「这一幕没有写完」。
 */
const openingInflight = new Map<number, Promise<void>>()

export function shareOpening(sessionId: number, start: () => Promise<void>): Promise<void> {
  const existing = openingInflight.get(sessionId)
  if (existing) return existing
  const pending = Promise.resolve().then(start).finally(() => {
    if (openingInflight.get(sessionId) === pending) openingInflight.delete(sessionId)
  })
  openingInflight.set(sessionId, pending)
  return pending
}
