/*
 * @Description: 侧边对话「暂无已完成轮次」判定与记忆的测试
 * @Author: YangHeng
 * @Date: 2026-10-10 21:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/fork-pending.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { SessionListSnapshot, SessionListStore } from '../tasks/host.js'
import { createForkPendingStore, forkBlocked, forkErrorText, isForkUnavailable, prunePending } from './fork-pending.js'

const HOST_ERROR = 'session/fork-unavailable: session abc has no completed turn to fork from'
const t = (key: string, vars?: Record<string, string | number>): string => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`)

function fakeList(init: SessionListSnapshot) {
  let snap = init
  const listeners = new Set<() => void>()
  const store: SessionListStore = {
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
  return {
    store,
    listeners,
    set(next: SessionListSnapshot) {
      snap = next
      for (const l of listeners) l()
    }
  }
}

describe('isForkUnavailable / forkErrorText', () => {
  it('识别宿主 fork-unavailable 错误（Error 与字符串）', () => {
    expect(isForkUnavailable(new Error(HOST_ERROR))).toBe(true)
    expect(isForkUnavailable(HOST_ERROR)).toBe(true)
    expect(isForkUnavailable(new Error('network down'))).toBe(false)
  })
  it('fork-unavailable 给友好文案，其他错误原样带出', () => {
    expect(forkErrorText(new Error(HOST_ERROR), t)).toBe('sidechat.waitTurn')
    expect(forkErrorText(new Error('boom'), t)).toBe('sidechat.forkFailed:{"message":"boom"}')
  })
})

describe('forkBlocked / prunePending', () => {
  it('仅「已记住且运行中」才禁用', () => {
    const pending = new Set(['a'])
    expect(forkBlocked(pending, { id: 'a', running: true })).toBe(true)
    expect(forkBlocked(pending, { id: 'a', running: false })).toBe(false)
    expect(forkBlocked(pending, { id: 'b', running: true })).toBe(false)
    expect(forkBlocked(pending, undefined)).toBe(false)
  })
  it('去掉不在运行的会话；无变化返回原引用', () => {
    const pending = new Set(['a', 'b'])
    expect(prunePending(pending, { byId: { a: { id: 'a', running: true }, b: { id: 'b', running: true } } })).toBe(pending)
    expect([...prunePending(pending, { byId: { a: { id: 'a', running: true }, b: { id: 'b' } } })]).toEqual(['a'])
    expect(prunePending(pending, { byId: {} }).size).toBe(0)
  })
})

describe('createForkPendingStore', () => {
  it('运行中才记住；运行结束自动清除并退订', () => {
    const list = fakeList({ byId: { a: { id: 'a', running: true } } })
    const store = createForkPendingStore()
    let notified = 0
    store.subscribe(() => notified++)
    expect(store.mark('a', list.store)).toBe(true)
    expect(store.getSnapshot().has('a')).toBe(true)
    expect(list.listeners.size).toBe(1)
    // 仍在运行：不变
    list.set({ byId: { a: { id: 'a', running: true } } })
    expect(store.getSnapshot().has('a')).toBe(true)
    // 第一轮结束：清除、通知、退订
    list.set({ byId: { a: { id: 'a', running: false } } })
    expect(store.getSnapshot().size).toBe(0)
    expect(notified).toBe(2)
    expect(list.listeners.size).toBe(0)
  })
  it('会话已不在运行或没有会话列表时不记住', () => {
    const store = createForkPendingStore()
    expect(store.mark('a', fakeList({ byId: { a: { id: 'a' } } }).store)).toBe(false)
    expect(store.mark('a', undefined)).toBe(false)
    expect(store.getSnapshot().size).toBe(0)
  })
})
