/*
 * @Description: 任务页在浏览器端用到的宿主客户端服务（ctx.jobs / ctx.sessions / 打开子代理）—— 结构探测 + 降级
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/host.ts
 *
 * 不 import 任何宿主包：只按结构判断服务是否可用，缺什么就让对应区块显示「当前 DSH 版本不支持」。
 * - ctx.jobs：dsh-api-job-controller/client 安装的后台任务服务（watchRows / observe / kill，observe 不移动模型的读取游标）；
 * - ctx.sessions.list：会话列表快照，projectionsBySession[id].values 里有 subagentCatalog（子代理目录）与 agentTeam（团队看板）；
 * - 打开子代理：侧栏 = sidebarRight.openResource(subagentchat 资源地址)（宿主 dsh-client-ui-subagent 注册的资源协议），
 *   主区 = uiWorkspace.openSession(address)（0.2 宿主的做法），旧宿主退回 sessions.openSubagent / sessions.open。
 */
import type { TeamTaskView } from '../../wire/tasks.js'

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** 宿主 JobView（线上形状）。 */
export interface JobView {
  id: string
  kind: string
  label: string
  /** 所属会话；没有 = 无主任务（所有会话都看得到）。 */
  owner?: string
  status: JobStatus
  progress?: string
  /** 结束后的详情（含退出码，如 'exit code: 3'）。 */
  detail?: string
  startedAt: number
  finishedAt?: number
}

export interface ObservedJob {
  text: string
  /** 输出有缺口（环形缓冲已覆盖 / 渲染尾部截断）。 */
  gapBefore: boolean
  streaming: boolean
  error?: string
}

export interface JobsSnapshot {
  /** 被 watch 的会话 → 它能看到的任务（整份替换）。 */
  rows: Record<string, JobView[] | undefined>
  observed: Record<string, ObservedJob | undefined>
}

export interface JobsService {
  state: { getSnapshot(): JobsSnapshot; subscribe(listener: () => void): () => void }
  watchRows(sessionId: string): () => void
  observe(sessionId: string | undefined, jobId: string): () => void
  kill(sessionId: string, jobId: string): Promise<void>
}

export interface SessionSummary {
  id: string
  displayTitle?: string
  parentId?: string
  running?: boolean
  origin?: string
  /** 还没有任何轮次（侧边对话据此隐藏「分叉」入口：空会话分叉不出东西）。 */
  blank?: boolean
}

export type SubagentMode = 'one-shot' | 'continuable' | 'unknown'

export interface CatalogEntry {
  id: string
  createdAt?: number
  mode?: SubagentMode
  label?: string
}

export interface TeamMemberProjection {
  id: string
  name: string
  role: 'lead' | 'teammate'
  phase: 'provisioning' | 'active' | 'failed'
  error?: string
}

export interface TeamProjection {
  members: readonly TeamMemberProjection[]
  tasks: readonly TeamTaskView[]
  failure?: string
}

export interface ProjectionSnapshot {
  values?: { subagentCatalog?: readonly CatalogEntry[]; agentTeam?: TeamProjection }
  state?: string
}

export interface SessionListSnapshot {
  byId: Record<string, SessionSummary | undefined>
  projectionsBySession?: Record<string, ProjectionSnapshot | undefined>
  /** 列表加载阶段（宿主 'ready' 之后才能据此判断「会话已删除」）。 */
  phase?: string
}

export interface SessionListStore {
  getSnapshot(): SessionListSnapshot
  subscribe(listener: () => void): () => void
}

export interface SubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: SubagentMode
}

/** 任务页需要的宿主能力（组件只依赖这个接口，预览 / 单测给替身）。 */
export interface TasksHost {
  jobs(): JobsService | undefined
  sessionList(): SessionListStore | undefined
  /** 在右侧栏打开子代理对话；宿主不支持返回 false。 */
  openChildAside(address: SubagentAddress): boolean
  /** 在主区打开子代理（或任意会话）；宿主不支持返回 false。 */
  openChildMain(address: SubagentAddress): boolean
  openSession(sessionId: string): boolean
}

const fn = (o: unknown, key: string): boolean => typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)[key] === 'function'

/** ctx.jobs 是否是可用的任务服务。 */
export function probeJobs(svc: unknown): JobsService | undefined {
  if (!fn(svc, 'watchRows') || !fn(svc, 'observe') || !fn(svc, 'kill')) return undefined
  const state = (svc as { state?: unknown }).state
  if (!fn(state, 'getSnapshot') || !fn(state, 'subscribe')) return undefined
  return svc as JobsService
}

/** ctx.sessions.list 是否可订阅。 */
export function probeSessionList(svc: unknown): SessionListStore | undefined {
  const list = typeof svc === 'object' && svc !== null ? (svc as { list?: unknown }).list : undefined
  return fn(list, 'getSnapshot') && fn(list, 'subscribe') ? (list as SessionListStore) : undefined
}

/** 宿主 dsh-client-ui-subagent 的子代理对话资源地址（与其 subagentChatAddress 逐字一致）。 */
export const SUBAGENT_CHAT_PREFIX = 'dsh-resource://subagentchat/session/'
export function subagentChatAddress(address: SubagentAddress): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `${SUBAGENT_CHAT_PREFIX}${encodeURIComponent(address.childSessionId)}?${query.toString()}`
}

interface HostCtx {
  get(name: string): unknown
}

export function createTasksHost(ctx: HostCtx): TasksHost {
  const get = (name: string): unknown => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const call = (target: unknown, key: string, ...args: unknown[]): boolean => {
    if (!fn(target, key)) return false
    try {
      ;(target as Record<string, (...a: unknown[]) => unknown>)[key]!(...args)
      return true
    } catch {
      return false
    }
  }
  return {
    jobs: () => probeJobs(get('jobs')),
    sessionList: () => probeSessionList(get('sessions')),
    openChildAside(address) {
      const tabs = get('sidebarRightTabs') as { get?: (kind: string) => unknown } | undefined
      // 宿主没注册 subagentchat 标签（旧版 / 精简环境）时 openResource 会落到别的处理方，直接判为不支持。
      if (fn(tabs, 'get') && tabs!.get!('subagentchat') === undefined) return false
      return call(get('sidebarRight'), 'openResource', subagentChatAddress(address), { kind: 'subagentchat', revealIfOpened: true })
    },
    openChildMain(address) {
      return (
        call(get('uiWorkspace'), 'openSession', address) ||
        call(get('sessions'), 'openSubagent', address) ||
        call(get('sessions'), 'open', address.childSessionId)
      )
    },
    openSession(sessionId) {
      return call(get('uiWorkspace'), 'openSession', sessionId) || call(get('sessions'), 'open', sessionId)
    }
  }
}
