/*
 * @Description: 子代理活动摘要折叠的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/subagent-activity.test.ts
 */
import { describe, expect, it } from 'vitest'
import { clip, foldActivity, toolDetail } from './subagent-activity.js'

let seq = 0
const ev = (type: string, data: Record<string, unknown>, time = 1000 + seq) => ({ type, seq: seq++, time, data })
const call = (callId: string, name: string, args: unknown) => ev('tool/call', { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args), turn: 1 })
const result = (callId: string, isError = false) => ev('tool/result', { message: { role: 'tool', source: { callId }, isError, content: [] } })
const say = (text: string) => ev('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })
const user = () => ev('user/message', { message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })

describe('foldActivity', () => {
  it('运行中：最近一次没有结果的调用 = 正在执行，带参数摘要；工具次数只数本轮', () => {
    const events = [user(), call('a', 'read', { file_path: '/x/old.ts' }), result('a'), user(), say('先看看'), call('b', 'grep', { pattern: 'foo' }), result('b'), call('c', 'bash', { command: 'npm test' })]
    const view = foldActivity(events, { live: true })
    expect(view.lastTool).toEqual({ name: 'bash', detail: 'npm test', settled: false })
    expect(view.toolCalls).toBe(2)
    expect(view.text).toBe('先看看')
    expect(view.lastEventTime).toBe(events[events.length - 1]!.time)
  })

  it('不在运行：没有结果的调用按已结束处理；结果报错带 error 标记', () => {
    const a = foldActivity([user(), call('x', 'bash', { command: 'exit 1' })], { live: false })
    expect(a.lastTool?.settled).toBe(true)
    const b = foldActivity([user(), call('y', 'bash', { command: 'exit 1' }), result('y', true)], { live: true })
    expect(b.lastTool).toMatchObject({ settled: true, error: true })
  })

  it('0.1.6 日志：错误标记在 tool-result 块上', () => {
    const r = ev('tool/result', { message: { source: { callId: 'z' }, content: [{ type: 'tool-result', isError: true }] } })
    expect(foldActivity([call('z', 'edit', { path: 'a' }), r], { live: true }).lastTool?.error).toBe(true)
  })

  it('最近文本取最新一条带文字的助手消息，并截断；坏事件跳过', () => {
    const long = 'x'.repeat(1000)
    const view = foldActivity([say('旧的'), null, { nope: 1 }, say(long)], { live: true })
    expect(view.text?.length).toBe(400)
    expect(view.text?.endsWith('…')).toBe(true)
    expect(view.toolCalls).toBe(0)
    expect(view.lastTool).toBeUndefined()
  })

  it('只扫尾部窗口', () => {
    const events = [say('很早'), ...Array.from({ length: 10 }, (_, i) => call(`w${i}`, 'read', { path: `${i}` }))]
    expect(foldActivity(events, { live: true, maxEvents: 5 }).text).toBeUndefined()
    expect(foldActivity(events, { live: true, maxEvents: 5 }).toolCalls).toBe(5)
  })

  it('空日志', () => {
    expect(foldActivity([], { live: true })).toEqual({ toolCalls: 0 })
  })
})

describe('toolDetail / clip', () => {
  it('按优先级取参数；数组拼接；非 JSON 退回工具名', () => {
    expect(toolDetail('subagent', { description: '调研', prompt: 'long' })).toBe('调研')
    expect(toolDetail('web_search', { queries: ['a', 'b'] })).toBe('a, b')
    expect(toolDetail('bash', '{bad json')).toBe('bash')
    expect(toolDetail('custom', { other: 1 })).toBe('custom')
  })
  it('压成一行、按码点截断不切坏 emoji', () => {
    expect(clip(' a\n  b ', 10)).toBe('a b')
    expect(clip('😀😀😀😀', 3)).toBe('😀😀…')
  })
})
