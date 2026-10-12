/*
 * @Description: 已建立连接上的 ssh2 error 必须有人接收（issue #6）
 * @Author: YangHeng
 * @Date: 2026-10-12 19:20:00
 * @FilePath: /dsh-workspace/src/ssh/connection.test.ts
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionLog } from '../log/connection-log.js'
import type { ResolvedTarget } from '../types.js'

/** 假 ssh2 Client：connect 时按 mode 异步发 ready 或 error。 */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = []
  static mode: 'ready' | 'error' = 'ready'
  constructor() {
    super()
    FakeClient.instances.push(this)
  }
  connect(): void {
    setImmediate(() => {
      if (FakeClient.mode === 'ready') this.emit('ready')
      else this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    })
  }
  end(): void {
    this.emit('close')
  }
}

vi.mock('./lazy.js', () => ({ requireSsh2: () => ({ Client: FakeClient }) }))

const { SshConnection } = await import('./connection.js')
const { SshPool } = await import('./pool.js')
const { KnownHosts } = await import('./hostkey.js')

const target: ResolvedTarget = {
  hostId: 'h1',
  label: 'h1',
  hostname: '10.0.0.1',
  port: 22,
  username: 'root',
  auth: { kind: 'password', password: 'x' },
  jumpChain: []
}

/** 模拟 ssh2 在已建立连接上的 socket 重置错误（字段与线上日志一致）。 */
function resetError(): Error {
  return Object.assign(new Error('read ECONNRESET'), {
    errno: -4077,
    code: 'ECONNRESET',
    syscall: 'read',
    level: 'client-socket'
  })
}

let sandbox: string

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-conn-'))
  process.env.DSH_HOME = sandbox
  FakeClient.instances = []
  FakeClient.mode = 'ready'
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

describe('ssh2 error 常驻监听', () => {
  it('握手成功后仍保留 error 监听，连接被重置时不抛出、只记 warn', async () => {
    const log = new ConnectionLog()
    await SshConnection.connect(target, new KnownHosts(), log)
    const client = FakeClient.instances[0]!
    expect(client.listenerCount('error')).toBeGreaterThan(0)
    // 没有监听者时 emit('error') 会同步抛出 —— 这正是宿主被 exit(1) 的原因。
    expect(() => client.emit('error', resetError())).not.toThrow()
    const warn = log.list('h1').find((e) => e.level === 'warn')
    expect(warn?.detail).toContain('ECONNRESET')
  })

  it('握手失败只记一条 error，不被常驻监听重复记录；之后的第二次错误也不抛出', async () => {
    FakeClient.mode = 'error'
    const log = new ConnectionLog()
    await expect(SshConnection.connect(target, new KnownHosts(), log)).rejects.toThrow(/ECONNREFUSED/)
    expect(log.list('h1').filter((e) => e.level === 'error')).toHaveLength(1)
    expect(log.list('h1').some((e) => e.level === 'warn')).toBe(false)
    expect(() => FakeClient.instances[0]!.emit('error', resetError())).not.toThrow()
  })

  it('连接池：出错并关闭后槽位回到 idle，下次 acquire 重建连接', async () => {
    const pool = new SshPool(new KnownHosts(), new ConnectionLog(), { maxReconnectAttempts: 1 })
    const first = await pool.acquire('h1', 'terminal', () => target)
    const client = FakeClient.instances[0]!
    client.emit('error', resetError())
    client.emit('close')
    expect(pool.statusOf('h1', 'terminal').phase).toBe('idle')
    const second = await pool.acquire('h1', 'terminal', () => target)
    expect(second).not.toBe(first)
    expect(FakeClient.instances).toHaveLength(2)
    pool.dispose()
  })
})
