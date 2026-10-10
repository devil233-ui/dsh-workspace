/*
 * @Description: 任务页宿主端数据（子代理活动 / workflow run / 团队写操作）与宿主内部对象探测降级的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/service.test.ts
 */
import { describe, expect, it } from 'vitest'
import { createHostInternal } from '../host-internal/index.js'
import { createTeamTask, updateTeamTask } from '../host-internal/teams.js'
import { subagentLive, workflowRuns } from './service.js'

const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ type, seq, time: seq * 10, data })

function host(options: { subagents?: boolean; events?: Record<string, unknown[]>; teams?: unknown; agents?: Record<string, unknown> } = {}) {
  let listener: ((s: unknown, e: unknown) => void) | undefined
  const services: Record<string, unknown> = {
    sessions: { get: (id: string) => (options.events?.[id] === undefined ? undefined : { snapshotEvents: () => options.events![id] }) },
    ...(options.subagents === false
      ? {}
      : {
          subagents: {
            listDescendants: async (root: string) => [
              { kind: 'child', id: 'c1', parentId: root, depth: 1, activity: 'running', mode: 'one-shot', hasChildren: false },
              { kind: 'diagnostic', id: 'bad', parentId: root, depth: 1, reason: 'corrupt' },
              { kind: 'child', id: 'c2', parentId: 'c1', depth: 2, activity: 'inactive', mode: 'continuable', label: 'x' }
            ]
          }
        }),
    ...(options.teams === undefined ? {} : { agentTeams: options.teams }),
    ...(options.agents === undefined ? {} : { agents: { get: (id: string) => options.agents![id] } })
  }
  const internal = createHostInternal({
    get: (n) => services[n],
    on: (_name, l) => {
      listener = l as (s: unknown, e: unknown) => void
      return () => {
        listener = undefined
      }
    }
  })
  return { internal, emit: (sessionId: string, e: unknown) => listener?.({ id: sessionId }, e) }
}

describe('subagentLive', () => {
  it('根 + 全部子代理（diagnostic 跳过）；子代理带目录的运行状态，读不到事件的只给状态', async () => {
    const { internal } = host({
      events: {
        root: [ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: '我来分派' }] } })],
        c1: [ev(1, 'tool/call', { callId: 'a', name: 'bash', arguments: '{"command":"ls"}' })]
      }
    })
    const r = await subagentLive(internal, 'root')
    expect(r.available).toBe(true)
    expect(Object.keys(r.live).sort()).toEqual(['c1', 'c2', 'root'])
    expect(r.live.root).toMatchObject({ text: '我来分派', toolCalls: 0 })
    expect(r.live.root!.state).toBeUndefined()
    expect(r.live.c1).toMatchObject({ state: 'running', lastTool: { name: 'bash', detail: 'ls', settled: false } })
    expect(r.live.c2).toEqual({ state: 'idle', toolCalls: 0 })
  })

  it('宿主没有子代理运行时 / 适配层缺失：available=false，不抛错', async () => {
    expect(await subagentLive(host({ subagents: false }).internal, 'root')).toEqual({ available: false, live: {} })
    expect(await subagentLive(undefined, 'root')).toEqual({ available: false, live: {} })
  })

  it('listDescendants 抛错 → 不可用', async () => {
    const internal = createHostInternal({ get: (n) => (n === 'subagents' ? { listDescendants: async () => { throw new Error('boom') } } : undefined) })
    expect((await subagentLive(internal, 'r')).available).toBe(false)
  })
})

describe('workflowRuns', () => {
  it('遍历任务树各会话；冷树根经回退读取；实时镜像补上快照落后的事件', async () => {
    const { internal, emit } = host({
      events: {
        c1: [ev(1, 'tool-workflow/run-start', { runId: 'w2', name: 'child-run' })]
      }
    })
    emit('c1', ev(2, 'tool-workflow/run-end', { runId: 'w2', stopReason: 'completed' }))
    emit('c1', ev(3, 'user/message', {}))
    const cold = async (id: string) => (id === 'root' ? [ev(0, 'tool-workflow/run-start', { runId: 'w1', name: 'root-run' })] : undefined)
    const r = await workflowRuns(internal, 'root', cold)
    expect(r.available).toBe(true)
    expect(r.runs.map((x) => [x.runId, x.originSessionId, x.status])).toEqual([
      ['w1', 'root', 'running'],
      ['w2', 'c1', 'completed']
    ])
  })

  it('没有 subagents 服务时只折叠树根；没有 sessions 服务时不可用', async () => {
    const { internal } = host({ subagents: false, events: { root: [ev(1, 'tool-workflow/run-start', { runId: 'w' })] } })
    expect((await workflowRuns(internal, 'root')).runs).toHaveLength(1)
    expect(await workflowRuns(createHostInternal({ get: () => undefined }), 'root')).toEqual({ available: false, runs: [] })
  })
})

describe('createHostInternal 探测', () => {
  it('ctx.get 抛错 / 没有 on：全部降级为不可用', async () => {
    const internal = createHostInternal({ get: () => { throw new Error('no service') } })
    expect(internal.hasSubagents()).toBe(false)
    expect(internal.hasSessionEvents()).toBe(false)
    expect(internal.liveEvents('x')).toBeUndefined()
    expect(internal.agentTeams()).toBeUndefined()
    expect(internal.liveAgent('x')).toBeUndefined()
    expect(await internal.listDescendants('x')).toBeUndefined()
    expect(internal.mirroredWorkflowEvents('x')).toEqual([])
    internal.dispose()
  })

  it('agentTeams 缺方法视为不可用', () => {
    expect(createHostInternal({ get: (n) => (n === 'agentTeams' ? { tryMembership: () => 1 } : undefined) }).agentTeams()).toBeUndefined()
  })
})

describe('团队写操作', () => {
  const task = { id: 't1', revision: 2, subject: 's', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }
  const teams = (impl: Partial<Record<'createTask' | 'updateTask', (agent: unknown, req: Record<string, unknown>) => Promise<unknown>>> = {}, member = true) => ({
    tryMembership: () => (member ? { team: 'x' } : undefined),
    createTask: impl.createTask ?? (async () => task),
    updateTask: impl.updateTask ?? (async () => ({ ...task, revision: 3 }))
  })

  it('成功：代表树根 Agent 调用，返回规范化的任务视图', async () => {
    const seen: unknown[] = []
    const { internal } = host({
      teams: teams({ createTask: async (agent, req) => (seen.push(agent, req), task) }),
      agents: { root: { id: 'agent-root' } }
    })
    const r = await createTeamTask(internal, { rootSessionId: 'root', subject: 's' })
    expect(r).toEqual({ ok: true, task })
    expect(seen).toEqual([{ id: 'agent-root' }, { subject: 's', description: '' }])
  })

  it('revision 过期 → conflict；其他拒绝 → error', async () => {
    const stale = Object.assign(new Error('stale'), { code: 'TEAM_TASK_STALE_REVISION' })
    const { internal } = host({ teams: teams({ updateTask: async () => { throw stale } }), agents: { root: {} } })
    expect(await updateTeamTask(internal, { rootSessionId: 'root', taskId: 't1', expectedRevision: 1, action: 'complete' })).toEqual({ ok: false, reason: 'conflict', message: 'stale' })
    const { internal: other } = host({ teams: teams({ updateTask: async () => { throw new Error('nope') } }), agents: { root: {} } })
    expect(await updateTeamTask(other, { rootSessionId: 'root', taskId: 't1', expectedRevision: 1, action: 'delete' })).toMatchObject({ ok: false, reason: 'error' })
  })

  it('实验层缺失 / Lead 不在本进程 / 不是 Lead', async () => {
    expect(await createTeamTask(host().internal, { rootSessionId: 'root', subject: 's' })).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await createTeamTask(undefined, { rootSessionId: 'root', subject: 's' })).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(await createTeamTask(host({ teams: teams(), agents: {} }).internal, { rootSessionId: 'root', subject: 's' })).toMatchObject({ ok: false, reason: 'not-live' })
    expect(await createTeamTask(host({ teams: teams({}, false), agents: { root: {} } }).internal, { rootSessionId: 'root', subject: 's' })).toMatchObject({ ok: false, reason: 'no-team' })
  })
})
