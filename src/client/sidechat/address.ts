/*
 * @Description: 侧边对话（方案 3.8）的纯逻辑 —— 资源地址、线程标题、边界提示与首条消息草稿预填
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/address.ts
 *
 * 不依赖 React 与宿主，便于单测；宿主交互见 host.ts，界面见 SidechatTab.tsx。
 */

/** 资源协议（= 地址里的 hostname）；与右侧栏标签 kind 同名，见 sidebar/kinds.ts 的 SIDECHAT_KIND。 */
export const SIDECHAT_PROTOCOL = 'dshws-sidechat'
/** 嵌入某个会话的资源地址前缀（照搬宿主 subagentchat 的 `dsh-resource://<协议>/session/<id>` 形状）。 */
export const SIDECHAT_ADDRESS_PREFIX = `dsh-resource://${SIDECHAT_PROTOCOL}/session/`
/** 侧栏标签的地址匹配（右侧栏注册用）。 */
export const SIDECHAT_PATTERN = `dsh-resource://${SIDECHAT_PROTOCOL}/**`

/** 线程标题前缀（与 better-sidebar 的 SIDE_LABEL_PREFIX 一致，左侧会话列表里一眼认出侧边对话）。 */
export const SIDE_TITLE_PREFIX = 'Side: '
/** 标题里保留的父会话标题字数（按 Unicode 码点计）。 */
export const SIDE_TITLE_CHARS = 20

export interface SidechatAddress {
  childId: string
  /** 父会话（来源）；旧地址或手写地址可能没有。 */
  parentId?: string
}

/** 子会话 → 资源地址。 */
export function sidechatAddress(childId: string, parentId?: string): string {
  const query = parentId === undefined || parentId === '' ? '' : `?${new URLSearchParams({ parent: parentId }).toString()}`
  return `${SIDECHAT_ADDRESS_PREFIX}${encodeURIComponent(childId)}${query}`
}

/** 解析资源地址；不是本协议 / 形状不对 / 编码损坏都返回 undefined（页面标签的 sidebar:// 地址也走这里判为「线程列表」）。 */
export function parseSidechatAddress(value: string): SidechatAddress | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== SIDECHAT_PROTOCOL) return undefined
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 2 || parts[0] !== 'session') return undefined
  let childId: string
  try {
    childId = decodeURIComponent(parts[1]!)
  } catch {
    return undefined
  }
  if (childId === '') return undefined
  const parent = url.searchParams.get('parent')
  return parent === null || parent === '' ? { childId } : { childId, parentId: parent }
}

/** 线程标题：`Side: <父会话标题前 20 字>`；父标题为空时退回会话 id 前 8 位。 */
export function sideTitle(parentTitle: string | undefined, parentId: string): string {
  const base = (parentTitle ?? '').replace(/\s+/g, ' ').trim()
  // 父会话本身就是侧边对话时不叠前缀（Side: Side: ...）。
  const plain = base.startsWith(SIDE_TITLE_PREFIX) ? base.slice(SIDE_TITLE_PREFIX.length).trim() : base
  const head = [...plain].slice(0, SIDE_TITLE_CHARS).join('')
  return `${SIDE_TITLE_PREFIX}${head === '' ? parentId.slice(0, 8) : head}`
}

/**
 * 侧边对话边界提示（参考 better-sidebar sidechat-core.ts 的 SIDE_BOUNDARY_PROMPT；首行保持一致，两个插件的线程可互认）。
 * 宿主 fork 只复制「最近一个已完成轮次」之前的历史，所以没有 BS 那段「进行中输出被冻结」的说明。
 * 面向模型的约定：改动请慎重。
 */
export const SIDE_BOUNDARY_PROMPT = `Side conversation boundary.

Everything before this boundary is inherited history from the parent session. It is reference context only. It is not your current task.

Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

Mode: this is a side conversation. Your answers stay in this side thread and are viewed in the side panel; they are never delivered into the parent session.

---

`

/** 宿主 ui-conversation 的每会话持久化 store 键（defineStore persist 'dsh.conversation' + 作用域后缀）。 */
export const CONVERSATION_STORE_KEY = 'dsh.conversation'

interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 给刚分叉出来的子会话预填首条消息草稿（边界提示 + 空行，用户接着写问题）。
 *
 * 为什么这样做（而不是 session.prompt / 隐藏注入）：
 * - 嵌入的是宿主原生输入框，宿主客户端没有「发送前给消息加前缀」的公开钩子；
 * - session.prompt 会立刻开一轮模型调用（耗额度、还会让模型对着空问题作答）；宿主也没有给客户端开放「只写入上下文不开轮次」的接口；
 * - 宿主输入框的草稿按会话持久化在 localStorage（`dsh.conversation.<sessionId>` = { draft, view, viewRequest }），
 *   会话视图首次挂载时若输入框为空就用它回填（ui-conversation DefaultConversationViews）。
 *   新分叉的会话还没有任何视图挂载过，此时写入草稿 = 用户看得见、可修改、可删除，且不改动会话本身。
 * 已有草稿记录（键存在）时不覆盖；写入失败（隐私模式 / 配额）静默放弃，只是少了预填。
 * @returns 是否写入
 */
export function primeBoundaryDraft(storage: KeyValueStorage | undefined, sessionId: string, text = SIDE_BOUNDARY_PROMPT): boolean {
  if (storage === undefined) return false
  const key = `${CONVERSATION_STORE_KEY}.${sessionId}`
  try {
    if (storage.getItem(key) !== null) return false
    storage.setItem(key, JSON.stringify({ draft: text, view: null, viewRequest: null }))
    return true
  } catch {
    return false
  }
}
