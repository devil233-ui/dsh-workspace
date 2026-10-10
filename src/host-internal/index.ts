/*
 * @Description: 宿主内部对象的集中适配层 —— 任务页（方案 3.7）用到的 subagents / agentTeams / agents / 会话事件 / session/event
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/host-internal/index.ts
 *
 * 为什么单独一层：这些都不是宿主公开 API（better-sidebar 也是结构化镜像着用），宿主升级随时可能改名 / 删掉。
 * 所以：
 * - 只在这里按「结构」探测（typeof xxx === 'function'），不 import 宿主包；
 * - 每次调用现取服务（服务可能晚于本插件提供、或被重建），取不到返回 undefined；
 * - 任何一步抛错都吞掉并返回 undefined —— 调用方据此返回 available:false，绝不让插件加载或网关调用失败。
 */

/** 会话事件的最小结构（宿主 SessionEvent 的子集）。 */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
}

/** subagents.listDescendants 的一行（宿主 SubagentRuntime 的结构镜像；diagnostic 行是读不出的坏子会话）。 */
export interface DescendantEntry {
  kind: 'child' | 'diagnostic'
  id: string
  parentId: string
  depth: number
  activity?: 'running' | 'inactive'
  mode?: 'one-shot' | 'continuable'
  label?: string
}

/** agentTeams 服务里本插件用到的写操作（实验层 dsh-experimental-agent-team）。 */
export interface AgentTeamsFace {
  tryMembership(agent: unknown): unknown
  createTask(agent: unknown, request: Record<string, unknown>): Promise<unknown>
  updateTask(agent: unknown, request: Record<string, unknown>): Promise<unknown>
}

export interface HostInternal {
  /** 宿主是否提供子代理运行时（subagents.listDescendants）。 */
  hasSubagents(): boolean
  /** 任务树的全部后代（前序）；服务缺失或读取失败返回 undefined。 */
  listDescendants(rootSessionId: string): Promise<DescendantEntry[] | undefined>
  /** 宿主 sessions 服务是否可读事件。 */
  hasSessionEvents(): boolean
  /** 运行中（已加载进内存）会话的事件快照（未校验的原始事件，用 asEvent 收窄）；不在内存 / 无此能力返回 undefined。 */
  liveEvents(sessionId: string): readonly unknown[] | undefined
  /** session/event 实时镜像里缓存的 tool-workflow/* 事件（宿主重启后的会话快照可能落后于实时事件）。 */
  mirroredWorkflowEvents(sessionId: string): readonly SessionEventLike[]
  /** agentTeams 写操作面；实验层未加载返回 undefined。 */
  agentTeams(): AgentTeamsFace | undefined
  /** 本进程内运行中的 Agent（团队写操作的身份凭据）；不存在返回 undefined。 */
  liveAgent(sessionId: string): unknown
  /** 释放事件监听（插件卸载时）。 */
  dispose(): void
}

/** 构造适配层所需的宿主上下文切面（cordis Context 的结构子集；测试替身可只给一部分）。 */
export interface ProbeContext {
  get?(name: string): unknown
  on?(name: string, listener: (...args: unknown[]) => void): unknown
}

/** 每个会话最多镜像多少条 workflow 事件 / 最多镜像多少个会话（有界，丢最旧的）。 */
const MIRROR_PER_SESSION = 500
const MIRROR_SESSIONS = 200

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 把任意对象收窄成事件结构；不合格返回 undefined（坏数据不让折叠逻辑崩）。 */
export function asEvent(raw: unknown): SessionEventLike | undefined {
  if (!isRec(raw) || typeof raw.type !== 'string') return undefined
  const seq = typeof raw.seq === 'number' ? raw.seq : -1
  const time = typeof raw.time === 'number' ? raw.time : 0
  return { type: raw.type, seq, time, data: isRec(raw.data) ? raw.data : {} }
}

export function createHostInternal(ctx: ProbeContext): HostInternal {
  const get = (name: string): unknown => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const subagents = (): { listDescendants(root: string): Promise<unknown> } | undefined => {
    const svc = get('subagents') as { listDescendants?: unknown } | undefined
    return svc !== undefined && svc !== null && typeof svc.listDescendants === 'function' ? (svc as { listDescendants(root: string): Promise<unknown> }) : undefined
  }
  const sessions = (): { get(id: string): unknown } | undefined => {
    const svc = get('sessions') as { get?: unknown } | undefined
    return svc !== undefined && svc !== null && typeof svc.get === 'function' ? (svc as { get(id: string): unknown }) : undefined
  }

  // session/event 镜像：只留 tool-workflow/*，有界。宿主没有事件总线（测试替身 / 旧版）时只靠快照。
  const mirror = new Map<string, SessionEventLike[]>()
  let offMirror: (() => void) | undefined
  try {
    if (typeof ctx.on === 'function') {
      const off = ctx.on('session/event', (session: unknown, event: unknown) => {
        const sessionId = isRec(session) ? session.id : undefined
        const e = asEvent(event)
        if (typeof sessionId !== 'string' || e === undefined || !e.type.startsWith('tool-workflow/')) return
        let list = mirror.get(sessionId)
        if (list === undefined) {
          if (mirror.size >= MIRROR_SESSIONS) mirror.delete(mirror.keys().next().value as string)
          list = []
          mirror.set(sessionId, list)
        }
        list.push(e)
        if (list.length > MIRROR_PER_SESSION) list.splice(0, list.length - MIRROR_PER_SESSION)
      })
      if (typeof off === 'function') offMirror = off as () => void
    }
  } catch {
    offMirror = undefined
  }

  return {
    hasSubagents: () => subagents() !== undefined,
    async listDescendants(rootSessionId) {
      const svc = subagents()
      if (svc === undefined) return undefined
      try {
        const rows = await svc.listDescendants(rootSessionId)
        if (!Array.isArray(rows)) return undefined
        const out: DescendantEntry[] = []
        for (const row of rows) {
          if (!isRec(row) || typeof row.id !== 'string') continue
          out.push({
            kind: row.kind === 'diagnostic' ? 'diagnostic' : 'child',
            id: row.id,
            parentId: typeof row.parentId === 'string' ? row.parentId : rootSessionId,
            depth: typeof row.depth === 'number' ? row.depth : 1,
            ...(row.activity === 'running' || row.activity === 'inactive' ? { activity: row.activity } : {}),
            ...(row.mode === 'one-shot' || row.mode === 'continuable' ? { mode: row.mode } : {}),
            ...(typeof row.label === 'string' ? { label: row.label } : {})
          })
        }
        return out
      } catch {
        return undefined
      }
    },
    hasSessionEvents: () => sessions() !== undefined,
    liveEvents(sessionId) {
      try {
        const live = sessions()?.get(sessionId) as { snapshotEvents?: () => unknown } | undefined
        if (live === undefined || live === null || typeof live.snapshotEvents !== 'function') return undefined
        // 原样返回（宿主给的是缓存的冻结快照）：折叠方按需逐条 asEvent，长会话不必整份复制。
        const raw = live.snapshotEvents()
        return Array.isArray(raw) ? raw : undefined
      } catch {
        return undefined
      }
    },
    mirroredWorkflowEvents: (sessionId) => mirror.get(sessionId) ?? [],
    agentTeams() {
      const svc = get('agentTeams') as Partial<AgentTeamsFace> | undefined
      if (svc === undefined || svc === null) return undefined
      if (typeof svc.tryMembership !== 'function' || typeof svc.createTask !== 'function' || typeof svc.updateTask !== 'function') return undefined
      return svc as AgentTeamsFace
    },
    liveAgent(sessionId) {
      try {
        const agents = get('agents') as { get?: (id: string) => unknown } | undefined
        if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined
        return agents.get(sessionId) ?? undefined
      } catch {
        return undefined
      }
    },
    dispose() {
      try {
        offMirror?.()
      } catch {
        /* 宿主已撤下事件总线 */
      }
      offMirror = undefined
      mirror.clear()
    }
  }
}
