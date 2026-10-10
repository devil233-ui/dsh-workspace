/*
 * @Description: 侧边对话纯逻辑的测试 —— 资源地址往返、标题、草稿预填
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/address.test.ts
 */
import { describe, expect, it } from 'vitest'
import { CONVERSATION_STORE_KEY, SIDE_BOUNDARY_PROMPT, parseSidechatAddress, primeBoundaryDraft, sideTitle, sidechatAddress } from './address.js'

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    }
  }
}

describe('sidechat 地址', () => {
  it('往返：特殊字符的会话 id 与父会话', () => {
    const addr = sidechatAddress('a b/c?#', 'p-1')
    expect(addr.startsWith('dsh-resource://dshws-sidechat/session/')).toBe(true)
    expect(parseSidechatAddress(addr)).toEqual({ childId: 'a b/c?#', parentId: 'p-1' })
    expect(parseSidechatAddress(sidechatAddress('x'))).toEqual({ childId: 'x' })
  })

  it('页面标签地址、别的协议、形状不对都不认', () => {
    for (const bad of ['sidebar://dshws-sidechat', 'sidebar://dshws-sidechat/123', 'dsh-resource://subagentchat/session/x', 'dsh-resource://dshws-sidechat/x', 'dsh-resource://dshws-sidechat/session/a/b', 'dsh-resource://dshws-sidechat/session/%E0%A4%A', 'nope']) {
      expect(parseSidechatAddress(bad)).toBeUndefined()
    }
  })
})

describe('sideTitle', () => {
  it('取父标题前 20 个码点，压缩空白；空标题退回 id 前 8 位；不叠前缀', () => {
    expect(sideTitle('  修复   登录页 bug ', 'p')).toBe('Side: 修复 登录页 bug')
    expect(sideTitle('一二三四五六七八九十一二三四五六七八九十多余', 'p')).toBe('Side: 一二三四五六七八九十一二三四五六七八九十')
    expect(sideTitle('😀'.repeat(25), 'p')).toBe(`Side: ${'😀'.repeat(20)}`)
    expect(sideTitle('', '0123456789abcdef')).toBe('Side: 01234567')
    expect(sideTitle(undefined, 'abc')).toBe('Side: abc')
    expect(sideTitle('Side: 原来的', 'p')).toBe('Side: 原来的')
  })
})

describe('primeBoundaryDraft', () => {
  it('写入宿主会话 store 的草稿形状；已有记录不覆盖；无存储 / 写入失败返回 false', () => {
    const s = memoryStorage()
    expect(primeBoundaryDraft(s, 'c1')).toBe(true)
    expect(JSON.parse(s.map.get(`${CONVERSATION_STORE_KEY}.c1`)!)).toEqual({ draft: SIDE_BOUNDARY_PROMPT, view: null, viewRequest: null })
    expect(SIDE_BOUNDARY_PROMPT.startsWith('Side conversation boundary.')).toBe(true)
    const kept = memoryStorage({ [`${CONVERSATION_STORE_KEY}.c2`]: '{"draft":"mine"}' })
    expect(primeBoundaryDraft(kept, 'c2')).toBe(false)
    expect(kept.map.get(`${CONVERSATION_STORE_KEY}.c2`)).toBe('{"draft":"mine"}')
    expect(primeBoundaryDraft(undefined, 'c3')).toBe(false)
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(primeBoundaryDraft(broken, 'c4')).toBe(false)
  })
})
