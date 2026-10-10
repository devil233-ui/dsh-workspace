/*
 * @Description: 文件树用到的宿主能力 —— @ 引用写入对话输入框、宿主 open-in-app（系统默认应用 / 在文件管理器中显示）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/host-bridge.ts
 *
 * 为什么集中在这里：这些都是宿主内部接口（DSH 0.2 实测），名字或形状变了只改这一个文件；每处都探测存在性，缺失时降级而不抛错。
 * - @ 引用：宿主原生 @ 选择器发的是会话作用域事件 `slash/input-insert-reference`（dsh-client-ui-conversation 监听），
 *   输入框据此插入一个整体的文件「芯片」（显示 @文件名，发送时序列化为 @相对路径）。插入失败（旧宿主 / 草稿版本号缺失）
 *   退回 composer.ts 的模拟粘贴纯文本 `@路径`，再不行复制到剪贴板。目录与多选一律用纯文本（宿主的目录引用语法本就是文本 `@dir/`）。
 * - open-in-app：`ctx.get('remote.session')` 的 canOpenWorkspacePath / openWorkspacePath（dsh-api-session-controller，
 *   路径为宿主机上的绝对路径）。只对本机会话有意义：远程文件不在宿主机上。
 * ctx 在 register.tsx 注册右侧栏时设置；预览 / 单测里没有 ctx，全部按「不可用」处理。
 */
import { insertIntoComposer, type InsertResult } from '../viewers/composer.js'

interface CtxLike {
  get(name: string): unknown
}

let hostCtx: CtxLike | undefined

export function setSidebarHost(ctx: CtxLike | undefined): void {
  hostCtx = ctx
  openInAppProbe = undefined
}

function get<T>(name: string): T | undefined {
  try {
    return hostCtx?.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * DSH 的 @ 文件引用写法（与宿主 dsh-file-reference 的 formatFileMention 一致）：
 * 无空白 = @path；有空白 = @"path"；含引号或控制字符无法表示，返回 undefined。目录以 / 结尾。
 */
export function fileMention(path: string, isDir: boolean): string | undefined {
  const p = path.replace(/\/+$/, '')
  if (p === '' || /[\u0000-\u001f\u007f-\u009f"]/u.test(p)) return undefined
  const body = isDir ? `${p === '.' ? '.' : p}/` : p
  return /\s/u.test(body) ? `@"${body}"` : `@${body}`
}

interface ConversationInput {
  state: { getSnapshot(): { draft: string; draftRev?: number } }
}

/** 结构化插入一个文件引用芯片；成功返回 true。 */
function insertChip(sessionId: string, mention: string, label: string): boolean {
  try {
    const sessions = get<{ scope?(id: string): unknown }>('sessions')
    const actx = sessions?.scope?.(sessionId) as { emit?(name: string, payload: unknown): unknown } | undefined
    const conversation = get<{ input?: { for?(scope: unknown): ConversationInput } }>('conversation')
    if (actx?.emit === undefined || conversation?.input?.for === undefined) return false
    const input = conversation.input.for(actx)
    const before = input.state.getSnapshot()
    if (before.draftRev === undefined) return false
    actx.emit('slash/input-insert-reference', {
      reference: { source: 'reference', ref: mention, label, appearance: 'file', clipboardText: mention },
      span: { draftRev: before.draftRev, start: before.draft.length, end: before.draft.length }
    })
    return input.state.getSnapshot().draftRev !== before.draftRev
  } catch {
    return false
  }
}

/**
 * 把一组路径作为 @ 引用写入会话输入框。items 的 path 是已换算好的「对话里使用的写法」（工作区内相对路径，工作区外绝对路径）。
 * 返回 inserted / copied（输入框找不到，已复制到剪贴板）/ failed；bad = 有无法表示的路径（含引号）。
 */
export async function referenceInChat(sessionId: string, items: ReadonlyArray<{ path: string; isDir: boolean }>): Promise<InsertResult | 'bad'> {
  const mentions = items.map((i) => fileMention(i.path, i.isDir))
  if (mentions.some((m) => m === undefined)) return 'bad'
  const only = items[0]
  if (items.length === 1 && only !== undefined && !only.isDir) {
    const label = only.path.slice(only.path.lastIndexOf('/') + 1)
    if (insertChip(sessionId, mentions[0] as string, label)) return 'inserted'
  }
  return insertIntoComposer(`${mentions.join(' ')} `)
}

// ------------------------------------------------------------------ open-in-app

interface SessionRemote {
  canOpenWorkspacePath?(): Promise<{ ok: boolean; value?: boolean }>
  openWorkspacePath?(request: { path: string; action?: 'reveal' }): Promise<{ ok: boolean }>
}

/**
 * 为什么直接 get('remote.session') 而不是 get('remote').session：
 * remote 是 cordis 服务，`.session` 会被追踪代理转成 ctx['remote.session'] 的属性访问，
 * 本插件 inject 里没有 remote.session，cordis 直接同步抛「cannot get property "remote.session" without inject」。
 * 这个异常发生在文件树的 useEffect 里（本机会话探测 open-in-app），被宿主插槽错误边界吞掉后整个标签变成空白。
 * ctx.get 不受 inject 约束，取不到返回 undefined；再包一层 try，任何形状变化都只降级为「不可用」。
 */
function sessionRemote(): SessionRemote | undefined {
  try {
    const s = get<SessionRemote>('remote.session')
    return s !== undefined && typeof s.openWorkspacePath === 'function' ? s : undefined
  } catch {
    return undefined
  }
}

let openInAppProbe: Promise<boolean> | undefined

/** 宿主能否把路径交给系统桌面打开（只探测一次；网页版远程访问时为 false）。 */
export function openInAppAvailable(): Promise<boolean> {
  if (openInAppProbe !== undefined) return openInAppProbe
  const s = sessionRemote()
  // 调用方在 React effect 里用它：同步抛错会让整个标签空白，所以这里保证只返回 Promise、永不抛。
  try {
    openInAppProbe =
      s?.canOpenWorkspacePath === undefined
        ? Promise.resolve(false)
        : Promise.resolve(s.canOpenWorkspacePath()).then(
            (r) => r.ok && r.value === true,
            () => false
          )
  } catch {
    openInAppProbe = Promise.resolve(false)
  }
  return openInAppProbe
}

/** 用系统默认应用打开（reveal = 在文件管理器中显示）。path 为宿主机原生绝对路径。 */
export async function openInApp(path: string, reveal = false): Promise<boolean> {
  const s = sessionRemote()
  if (s?.openWorkspacePath === undefined) return false
  try {
    return (await s.openWorkspacePath(reveal ? { path, action: 'reveal' } : { path })).ok
  } catch {
    return false
  }
}
