/*
 * @Description: 从会话事件折叠出子代理的实时活动摘要（最近工具 / 正在执行的工具 / 最近文本 / 本轮工具次数）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/subagent-activity.ts
 *
 * 为什么在宿主折叠：浏览器拿不到子代理的事件日志（宿主客户端只给投影），better-sidebar 也是宿主路由折叠。
 * 只从尾部往前扫有限条数（默认 400），长会话的成本只取决于最近一段。纯函数，便于单测。
 *
 * 事件格式（宿主会话日志）：
 * - tool/call      { callId, name, arguments(JSON 字符串), turn }
 * - tool/result    { message: { source: { callId }, isError?, content } }（0.1.6 的错误标记在 tool-result 块上）
 * - assistant/message { message: { content: [{ type: 'text', text }, …] } }
 * - user/message   一轮的起点（工具次数只数到这里）
 */
import { LIVE_DETAIL_MAX, LIVE_TEXT_MAX, type SubagentLiveView, type ToolBrief } from '../wire/tasks.js'
import { asEvent } from '../host-internal/index.js'

export const ACTIVITY_WINDOW = 400

/** 宿主聊天界面「正在执行」详情的取值顺序（取第一个有值的参数）。 */
const DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'prompt', 'message',
  'command', 'cmd', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status'
] as const

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 压成一行并按字符截断（Array.from 按码点切，不会切坏代理对）。 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** 工具参数里最能说明意图的一段；都没有时用工具名。 */
export function toolDetail(name: string, rawArgs: unknown): string {
  let args: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      return clip(name, LIVE_DETAIL_MAX)
    }
  }
  if (isRec(args)) {
    for (const key of DETAIL_KEYS) {
      const v = args[key]
      const text = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : ''
      if (text.trim() !== '') return clip(text, LIVE_DETAIL_MAX)
    }
  }
  return clip(name, LIVE_DETAIL_MAX)
}

/** content 块列表里的纯文本（只取 type:'text'）。 */
export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (isRec(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

function resultCallId(data: Record<string, unknown>): string | undefined {
  const message = isRec(data.message) ? data.message : undefined
  const source = message !== undefined && isRec(message.source) ? message.source : undefined
  for (const c of [data.callId, source?.callId, message?.toolCallId]) {
    if (typeof c === 'string' && c !== '') return c
  }
  return undefined
}

function resultIsError(data: Record<string, unknown>): boolean {
  const message = isRec(data.message) ? data.message : undefined
  if (message === undefined) return data.isError === true
  if (message.isError === true) return true
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRec(block) && block.type === 'tool-result') return block.isError === true
    }
  }
  return false
}

/**
 * 折叠一个会话的活动摘要。
 * @param events 会话事件（旧 → 新，未校验的原始对象）
 * @param options.live 会话是否在运行：不在运行时，没有结果的调用不算「正在执行」（被中断 / 宿主重启）
 */
export function foldActivity(events: readonly unknown[], options: { live: boolean; maxEvents?: number }): Omit<SubagentLiveView, 'state'> {
  const max = Math.max(1, options.maxEvents ?? ACTIVITY_WINDOW)
  const results = new Map<string, boolean>()
  let lastTool: ToolBrief | undefined
  let text: string | undefined
  let lastEventTime: number | undefined
  let toolCalls = 0
  let inTurn = true
  for (let i = events.length - 1, scanned = 0; i >= 0 && scanned < max; i -= 1, scanned += 1) {
    const e = asEvent(events[i])
    if (e === undefined) continue
    if (lastEventTime === undefined && e.time > 0) lastEventTime = e.time
    if (e.type === 'tool/result') {
      const id = resultCallId(e.data)
      if (id !== undefined && !results.has(id)) results.set(id, resultIsError(e.data))
    } else if (e.type === 'tool/call') {
      if (inTurn) toolCalls += 1
      if (lastTool === undefined) {
        const name = typeof e.data.name === 'string' ? e.data.name : 'tool'
        const id = typeof e.data.callId === 'string' ? e.data.callId : undefined
        const settled = id !== undefined && results.has(id)
        lastTool = {
          name,
          detail: toolDetail(name, e.data.arguments),
          // 不在运行的会话里，没有结果的调用已不会再有结果：按「已结束」显示，避免永远转圈。
          settled: settled || !options.live,
          ...(settled && results.get(id as string) === true ? { error: true } : {})
        }
      }
    } else if (e.type === 'assistant/message') {
      if (text === undefined) {
        const message = isRec(e.data.message) ? e.data.message : undefined
        const t = contentText(message?.content)
        if (t !== undefined) text = clip(t, LIVE_TEXT_MAX)
      }
    } else if (e.type === 'user/message') {
      // 本轮从这里开始：之前的调用不计入次数；最近工具 / 文本都拿到了就不必再往前扫。
      inTurn = false
      if (lastTool !== undefined && text !== undefined) break
    }
  }
  return {
    toolCalls,
    ...(lastTool === undefined ? {} : { lastTool }),
    ...(text === undefined ? {} : { text }),
    ...(lastEventTime === undefined ? {} : { lastEventTime })
  }
}
