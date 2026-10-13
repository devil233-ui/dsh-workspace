/*
 * @Description: 远程工作区绑定测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/workspace/bindings.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  BindingStore,
  REMOTE_ROOT_SEGMENT,
  folderName,
  relativeToRoot,
  remotePathSegments,
  remoteWorkspacesRoot,
  toRemotePath
} from './bindings.js'
import { WORKSPACE_META_FILE, bindingsFile } from '../paths.js'

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-bind-'))
  process.env.DSH_HOME = sandbox
})
afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(sandbox, { recursive: true, force: true })
})

const input = { hostId: 'h1', endpoint: '10.0.0.1-root-22', remotePath: '/home/ps/中山渔业', title: '中山渔业' }

describe('BindingStore', () => {
  it('创建占位目录、写 meta、登记；目录名保留中文', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(existsSync(b.localPath)).toBe(true)
    expect(path.basename(b.localPath)).toBe('中山渔业')
    const meta = JSON.parse(readFileSync(path.join(b.localPath, WORKSPACE_META_FILE), 'utf8'))
    expect(meta).toMatchObject({ kind: 'dsh-workspace/remote', hostId: 'h1', remotePath: '/home/ps/中山渔业' })
    expect(store.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
  })

  it('同一主机同一远程目录再次创建：幂等返回同一记录', () => {
    const store = new BindingStore()
    expect(store.create(input).localPath).toBe(store.create(input).localPath)
    expect(store.list()).toHaveLength(1)
  })

  it('旧布局登记再次创建：迁移到新布局路径，旧登记删除且旧目录不动', () => {
    const store = new BindingStore()
    // 手工构造一条旧布局登记（旧版占位目录 = <endpoint>/<标题>）。
    const legacyDir = path.join(remoteWorkspacesRoot(), input.endpoint, folderName(input.title))
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, WORKSPACE_META_FILE), JSON.stringify({ kind: 'dsh-workspace/remote', version: 1, hostId: input.hostId, remotePath: input.remotePath, title: input.title, createdAt: '2026-01-01T00:00:00.000Z' }, null, 2), 'utf8')
    store.resolve(legacyDir) // 触发 meta 自愈，把旧布局登记补进映射表
    expect(store.list()).toHaveLength(1)

    const b = store.create(input)
    expect(b.localPath).toBe(path.join(remoteWorkspacesRoot(), input.endpoint, ...remotePathSegments(input.remotePath)))
    expect(b.localPath).not.toBe(legacyDir)
    expect(existsSync(path.join(b.localPath, WORKSPACE_META_FILE))).toBe(true)
    // 登记表只剩新布局一条；旧目录与其 meta 原样保留（已有会话 cwd 仍指向它）。
    expect(store.list()).toHaveLength(1)
    expect(existsSync(legacyDir)).toBe(true)
    expect(existsSync(path.join(legacyDir, WORKSPACE_META_FILE))).toBe(true)
    // 旧目录的 meta 不再把已迁移的登记复活回旧路径（幽灵防线：旧目录彻底退役，
    // 仍指向它的会话不再被认作远程工作区——迁会话是使用者的决定）。
    expect(store.resolve(legacyDir)).toBeUndefined()
    expect(store.list()).toHaveLength(1)
  })

  it('新布局登记再次创建不受迁移分支影响：直接幂等返回', () => {
    const store = new BindingStore()
    const first = store.create(input)
    const again = store.create(input)
    expect(again.localPath).toBe(first.localPath)
    expect(again.createdAt).toBe(first.createdAt)
    expect(store.list()).toHaveLength(1)
  })

  it('占位目录按远程路径结构展开：子目录落在父工作区目录内（DSH 按工作区树据此嵌套）', () => {
    const store = new BindingStore()
    const parent = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    const child = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: '云崽' })
    expect(parent.localPath).toBe(path.join(remoteWorkspacesRoot(), 'ep', 'root'))
    expect(child.localPath).toBe(path.join(parent.localPath, 'Yunzai'))
    expect(store.resolve(child.localPath)?.remotePath).toBe('/root/Yunzai')
  })

  it('先建子目录再建父目录：父目录收编中间层，创建顺序不影响嵌套', () => {
    const store = new BindingStore()
    const child = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root/Yunzai', title: '云崽' })
    const parent = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    expect(parent.localPath).toBe(path.dirname(child.localPath))
    expect(new BindingStore().resolve(parent.localPath)?.remotePath).toBe('/root')
  })

  it('远程根用固定段，不与常见的 /root 抢同一个目录', () => {
    const store = new BindingStore()
    const root = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/', title: 'root' })
    const home = store.create({ hostId: 'h1', endpoint: 'ep', remotePath: '/root', title: 'root' })
    expect(path.basename(root.localPath)).toBe(REMOTE_ROOT_SEGMENT)
    expect(home.localPath).toBe(path.join(remoteWorkspacesRoot(), 'ep', 'root'))
    expect(root.localPath).not.toBe(home.localPath)
  })

  it('不同远程目录消毒后落到同一段：目录名追加短哈希，不串台', () => {
    const store = new BindingStore()
    const a = store.create({ ...input, remotePath: '/srv/a:b', title: 'a:b' })
    const b = store.create({ ...input, remotePath: '/srv/a*b', title: 'a*b' })
    expect(a.localPath).not.toBe(b.localPath)
    expect(store.resolve(a.localPath)?.remotePath).toBe('/srv/a:b')
    expect(store.resolve(b.localPath)?.remotePath).toBe('/srv/a*b')
  })

  it('会话 cwd 写法不同（大小写 / 结尾斜杠 / 子目录）也能反查', () => {
    const store = new BindingStore()
    const b = store.create({ ...input, title: 'App' })
    expect(store.resolve(`${b.localPath}${path.sep}`)?.hostId).toBe('h1')
    expect(store.resolve(path.join(b.localPath, 'sub', 'dir'))?.hostId).toBe('h1')
    if (process.platform === 'win32') expect(store.resolve(b.localPath.toUpperCase())?.hostId).toBe('h1')
  })

  it('本地普通目录不是远程工作区', () => {
    expect(new BindingStore().resolve(sandbox)).toBeUndefined()
    expect(new BindingStore().resolve(undefined)).toBeUndefined()
  })

  it('映射表丢失：按占位目录里的 meta 文件自愈并补登记', () => {
    const b = new BindingStore().create(input)
    unlinkSync(bindingsFile())
    const fresh = new BindingStore()
    expect(fresh.resolve(b.localPath)?.remotePath).toBe('/home/ps/中山渔业')
    expect(existsSync(bindingsFile())).toBe(true)
  })

  it('映射表损坏不抛错', () => {
    const store = new BindingStore(() => path.join(sandbox, 'bad.json'))
    writeFileSync(path.join(sandbox, 'bad.json'), '{not json')
    expect(store.list()).toEqual([])
  })

  it('解除登记后不再是远程工作区（meta 也要避免自愈：remove 后删 meta 由调用方决定）', () => {
    const store = new BindingStore()
    const b = store.create(input)
    expect(store.remove(b.localPath)).toBe(true)
    unlinkSync(path.join(b.localPath, WORKSPACE_META_FILE))
    expect(store.resolve(b.localPath)).toBeUndefined()
  })
})

describe('remotePathSegments', () => {
  it('逐段消毒、丢弃空段与 . / ..；远程根用固定段', () => {
    expect(remotePathSegments('/home/ps/中山渔业')).toEqual(['home', 'ps', '中山渔业'])
    expect(remotePathSegments('/srv/a:b*c')).toEqual(['srv', 'a_b_c'])
    expect(remotePathSegments('/./a//b/../c/')).toEqual(['a', 'b', 'c'])
    expect(remotePathSegments('/')).toEqual([REMOTE_ROOT_SEGMENT])
    expect(remotePathSegments('')).toEqual([REMOTE_ROOT_SEGMENT])
  })
})

describe('folderName', () => {
  it('替换非法字符、处理保留名与结尾点', () => {
    expect(folderName('a:b*c?')).toBe('a_b_c_')
    expect(folderName('con')).toBe('_con')
    expect(folderName('name. ')).toBe('name')
    expect(folderName('')).toBe('_')
  })
})

describe('toRemotePath', () => {
  const b = { localPath: path.join(tmpdir(), 'ph', 'app'), hostId: 'h', remotePath: '/srv/app', title: 'app', createdAt: '' }

  it('远程绝对路径原样；相对路径相对远程根；. 与 .. 折叠', () => {
    expect(toRemotePath(b, '/etc/hosts')).toBe('/etc/hosts')
    expect(toRemotePath(b, 'src/a.ts')).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, './src/../README.md')).toBe('/srv/app/README.md')
    expect(toRemotePath(b, '.')).toBe('/srv/app')
  })

  it('模型照抄会话 cwd 写出的本地绝对路径 → 换成远程根下对应路径', () => {
    expect(toRemotePath(b, path.join(b.localPath, 'src', 'a.ts'))).toBe('/srv/app/src/a.ts')
    expect(toRemotePath(b, b.localPath)).toBe('/srv/app')
  })

  it('【安全】占位目录以外的本机路径一律拒绝 —— 远程会话绝不能碰本机文件', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : path.join(tmpdir(), 'other')
    if (process.platform === 'win32') expect(() => toRemotePath(b, outside)).toThrow(/本机路径/)
  })

  it('relativeToRoot', () => {
    expect(relativeToRoot(b, '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(relativeToRoot(b, '/srv/app')).toBe('.')
    expect(relativeToRoot(b, '/etc/x')).toBe('/etc/x')
  })
})
