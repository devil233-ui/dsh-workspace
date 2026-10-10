/*
 * @Description: 任务页数据整理（任务树、根查找、后台任务行合并、团队、时长）与宿主服务探测的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/model.test.ts
 */
import { describe, expect, it } from 'vitest'
import { buildTree, collectJobRows, flattenTree, formatDuration, memberStatus, rootAncestor, tasksByStatus, teamOf } from './model.js'
import { createTasksHost, probeJobs, subagentChatAddress } from './host.js'
import type { JobView, SessionListSnapshot } from './host.js'

const list: SessionListSnapshot = {
  byId: {
    root: { id: 'root', displayTitle: '主会话' },
    c1: { id: 'c1', displayTitle: 'c1', parentId: 'root', running: true },
    other: { id: 'other', displayTitle: '别的' }
  },
  projectionsBySession: {
    root: { values: { subagentCatalog: [{ id: 'c1', mode: 'one-shot', label: '调研', createdAt: 1 }, { id: 'c2', mode: 'continuable', label: '写代码' }] } },
    c1: { values: { subagentCatalog: [{ id: 'g1', mode: 'unknown' }, { id: 'root' }] } }
  }
}

describe('任务树', () => {
  it('根查找走父链（会话摘要 + 目录反推），构建树防环，标题优先会话标题、其次目录 label', () => {
    expect(rootAncestor(list, 'g1')).toBe('root')
    expect(rootAncestor(list, 'other')).toBe('other')
    const tree = buildTree(list, 'root')
    const flat = flattenTree(tree)
    expect(flat.map((n) => [n.id, n.depth, n.title])).toEqual([
      ['root', 0, '主会话'],
      ['c1', 1, '调研'],
      ['g1', 2, 'g1'],
      ['c2', 1, '写代码']
    ])
    expect(flat[1]!.mode).toBe('one-shot')
  })
})

describe('collectJobRows', () => {
  const job = (id: string, extra: Partial<JobView> = {}): JobView => ({ id, kind: 'bash', label: id, status: 'completed', startedAt: 10, finishedAt: 20, ...extra })
  it('按 id 去重（无主任务出现在多个名册里）、丢弃树外归属、进行中在前', () => {
    const rows = collectJobRows(
      {
        rows: {
          root: [job('j1'), job('shared'), job('run', { status: 'running', startedAt: 30, finishedAt: undefined })],
          c1: [job('shared'), job('own', { owner: 'c1', finishedAt: 50 })],
          other: [job('outside')],
          root2: undefined
        },
        observed: {}
      },
      list,
      new Set(['root', 'c1'])
    )
    expect(rows.map((r) => r.job.id)).toEqual(['run', 'own', 'j1', 'shared'])
    expect(rows.find((r) => r.job.id === 'own')?.ownerSessionId).toBe('c1')
    const leaked = collectJobRows({ rows: { root: [job('x', { owner: 'other' })] }, observed: {} }, list, new Set(['root']))
    expect(leaked).toEqual([])
  })
})

describe('团队 / 时长', () => {
  it('teamOf 只在投影形状完整时返回；成员状态以持久阶段优先；看板分列跳过已删除', () => {
    expect(teamOf(list, 'root')).toBeUndefined()
    const team = { members: [{ id: 'c1', name: 'a', role: 'teammate' as const, phase: 'active' as const }], tasks: [] }
    const withTeam = { ...list, projectionsBySession: { root: { values: { agentTeam: team } } } }
    expect(teamOf(withTeam, 'root')).toBe(team)
    expect(memberStatus(team.members[0]!, {}, list)).toBe('running')
    expect(memberStatus({ ...team.members[0]!, phase: 'failed' }, {}, list)).toBe('failed')
    expect(memberStatus(team.members[0]!, { c1: { state: 'idle', toolCalls: 0 } }, list)).toBe('idle')
    const t = (id: string, status: 'pending' | 'deleted' | 'completed') => ({ id, revision: 0, subject: id, description: '', status, blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [] })
    const cols = tasksByStatus([t('a', 'pending'), t('b', 'deleted'), t('c', 'completed')])
    expect([cols.pending.length, cols.in_progress.length, cols.completed.length]).toEqual([1, 0, 1])
  })
  it('formatDuration', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(185_000)).toBe('3m 05s')
    expect(formatDuration(3_720_000)).toBe('1h 02m')
    expect(formatDuration(-5)).toBe('0s')
  })
})

describe('宿主服务探测', () => {
  it('ctx.jobs 缺方法视为不支持；子代理对话地址与宿主格式一致', () => {
    expect(probeJobs(undefined)).toBeUndefined()
    expect(probeJobs({ watchRows() {}, observe() {}, kill() {} })).toBeUndefined()
    expect(subagentChatAddress({ parentSessionId: 'p 1', childSessionId: 'c/1', mode: 'one-shot' })).toBe('dsh-resource://subagentchat/session/c%2F1?parent=p+1&mode=one-shot')
  })
  it('打开子代理：侧栏未注册 subagentchat 时不支持；主区优先 uiWorkspace.openSession，其次 sessions.open', () => {
    const calls: unknown[] = []
    const services: Record<string, unknown> = {
      sidebarRightTabs: { get: () => undefined },
      sidebarRight: { openResource: (...a: unknown[]) => calls.push(['res', ...a]) },
      sessions: { open: (id: string) => calls.push(['open', id]) }
    }
    const h = createTasksHost({ get: (n) => services[n] })
    const address = { parentSessionId: 'p', childSessionId: 'c', mode: 'one-shot' as const }
    expect(h.openChildAside(address)).toBe(false)
    expect(h.openChildMain(address)).toBe(true)
    expect(calls).toEqual([['open', 'c']])
    services.uiWorkspace = { openSession: (t: unknown) => calls.push(['ws', t]) }
    services.sidebarRightTabs = { get: () => ({ id: 'x' }) }
    expect(h.openChildMain(address)).toBe(true)
    expect(h.openChildAside(address)).toBe(true)
    expect(calls.slice(1)).toEqual([['ws', address], ['res', subagentChatAddress(address), { kind: 'subagentchat', revealIfOpened: true }]])
    expect(createTasksHost({ get: () => { throw new Error('x') } }).jobs()).toBeUndefined()
  })
})
