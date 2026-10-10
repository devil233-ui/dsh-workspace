/*
 * @Description: 侧栏打开入口（浏览器端）单测 —— callId 去重、地址解析、结果分派、卡片状态 / 参数解析
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/open-in-sidebar.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  createCallDedupe,
  createSidebarOpener,
  fileAddressOf,
  revealPathOf,
  rowStateOf,
  targetOfArgs,
  type OpenerDeps
} from './open-in-sidebar.js'
import { navOf } from './RemoteFileTab.js'

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

const REMOTE_WS = { localPath: 'C:\\Users\\me\\.dsh\\remote\\h1\\app', hostId: 'h1', remotePath: '/srv/app', title: 'app' }
const index: OpenerDeps['index'] = {
  bySession: (id: string) => (id === 'remote' ? REMOTE_WS : undefined),
  sessionCwd: (id: string) => (id === 'local' ? 'C:\\work\\proj' : id === 'remote' ? REMOTE_WS.localPath : undefined)
}

describe('createCallDedupe', () => {
  it('只有本页看到过进行中的调用，变成 ok 时才打开一次', () => {
    const d = createCallDedupe(memoryStorage())
    expect(d.observe('c1', 'running')).toBe(false)
    expect(d.observe('c1', 'running')).toBe(false)
    expect(d.observe('c1', 'ok')).toBe(true)
    // 重新渲染 / 重新挂载再报一次 ok：不再打开。
    expect(d.observe('c1', 'ok')).toBe(false)
  })

  it('历史重放（一挂载就是 ok）不打开；失败 / 中止不打开', () => {
    const d = createCallDedupe(memoryStorage())
    expect(d.observe('old', 'ok')).toBe(false)
    d.observe('e', 'running')
    expect(d.observe('e', 'error')).toBe(false)
    d.observe('s', 'running')
    expect(d.observe('s', 'stopped')).toBe(false)
    expect(d.observe('', 'running')).toBe(false)
    expect(d.observe('', 'ok')).toBe(false)
  })

  it('已处理记录落在 storage：模块状态丢失（热重载）后同一 callId 不重复打开', () => {
    const storage = memoryStorage()
    const a = createCallDedupe(storage)
    a.observe('c2', 'running')
    expect(a.observe('c2', 'ok')).toBe(true)
    const b = createCallDedupe(storage)
    b.observe('c2', 'running')
    expect(b.observe('c2', 'ok')).toBe(false)
  })

  it('storage 不可用时只靠内存去重，不抛错', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    const d = createCallDedupe(broken)
    d.observe('c3', 'running')
    expect(d.observe('c3', 'ok')).toBe(true)
    expect(d.observe('c3', 'ok')).toBe(false)
  })
})

describe('地址解析', () => {
  it('本机会话：工作区内相对 / 绝对 → 相对路径的会话地址；工作区外 → 绝对路径的会话地址', () => {
    expect(fileAddressOf(index, 'local', 'src/a.ts')).toBe('dsh-resource://file/session/local/src/a.ts')
    expect(fileAddressOf(index, 'local', 'C:\\work\\proj\\src\\..\\b.md')).toBe('dsh-resource://file/session/local/b.md')
    expect(fileAddressOf(index, 'local', 'D:\\x\\y.txt')).toBe('dsh-resource://file/session/local/D:/x/y.txt')
  })

  it('远程会话：远程路径 → 会话地址；盘符路径 → absolute 地址；强制 local 时 / 开头也不当远程', () => {
    expect(fileAddressOf(index, 'remote', 'README.md')).toBe('dsh-resource://file/session/remote//srv/app/README.md')
    expect(fileAddressOf(index, 'remote', '/etc/hosts')).toBe('dsh-resource://file/session/remote//etc/hosts')
    expect(fileAddressOf(index, 'remote', 'D:\\shots\\a.png')).toBe('dsh-resource://file/absolute/D:/shots/a.png')
    expect(fileAddressOf(index, 'remote', '/Users/me/a.png', 'local')).toBe('dsh-resource://file/absolute/Users/me/a.png')
    expect(fileAddressOf(index, 'local', '/srv/x', 'remote')).toBeUndefined()
  })

  it('没有会话只接受绝对路径；UNC 不认领', () => {
    expect(fileAddressOf(index, undefined, 'C:\\a\\b.md')).toBe('dsh-resource://file/absolute/C:/a/b.md')
    expect(fileAddressOf(index, undefined, 'b.md')).toBeUndefined()
    expect(fileAddressOf(index, 'local', '\\\\server\\share\\x')).toBeUndefined()
  })

  it('定位路径：远程 → 远程绝对路径；本机 → 本地 POSIX 形式', () => {
    expect(revealPathOf(index, 'remote', 'src')).toBe('/srv/app/src')
    expect(revealPathOf(index, 'remote', '/srv/app/src', 'local')).toBeUndefined()
    expect(revealPathOf(index, 'local', 'src')).toBe('/C:/work/proj/src')
  })
})

describe('createSidebarOpener', () => {
  const make = (current: string | undefined, kinds: string[] = ['dsh-workspace:remote-files', 'dsh-workspace:git', 'browser']) => {
    const calls: Array<[string, string, unknown]> = []
    const opener = createSidebarOpener({
      index,
      right: () => ({
        openResource: (address, options) => void calls.push(['resource', address, options]),
        openTab: (kind, options) => void calls.push(['tab', kind, options])
      }),
      hasKind: (k) => kinds.includes(k),
      currentSession: () => current,
      filesKind: () => 'dsh-workspace:remote-files',
      now: () => 42
    })
    return { opener, calls }
  }

  it('openResult：文件 / 文件夹 / 网址分派到 openResource / 文件管理定位 / 浏览器标签', () => {
    const { opener, calls } = make('remote')
    expect(opener.openResult({ kind: 'file', target: '/srv/app/a.md', title: 'a.md', delivered: true, remoteHost: 'h1' })).toBe(true)
    expect(opener.openResult({ kind: 'folder', target: '/srv/app/src', title: 'src', delivered: true, remoteHost: 'h1' })).toBe(true)
    expect(opener.openResult({ kind: 'url', target: 'https://example.com', title: 'example.com', delivered: true })).toBe(true)
    expect(calls).toEqual([
      ['resource', 'dsh-resource://file/session/remote//srv/app/a.md', { revealIfOpened: true }],
      ['tab', 'dsh-workspace:remote-files', { params: { reveal: '/srv/app/src', expand: true, nonce: 42 }, revealIfOpened: true }],
      ['tab', 'browser', { params: { url: 'https://example.com' }, revealIfOpened: true }]
    ])
  })

  it('远程结果只在同一主机的远程会话里打开；本机结果在远程会话里按本机 absolute 地址打开', () => {
    const local = make('local')
    expect(local.opener.openResult({ kind: 'file', target: '/srv/app/a.md', title: 'a', delivered: true, remoteHost: 'h1' })).toBe(false)
    const other = make('remote')
    expect(other.opener.openResult({ kind: 'file', target: '/srv/app/a.md', title: 'a', delivered: true, remoteHost: 'h2' })).toBe(false)
    expect(other.opener.openResult({ kind: 'file', target: 'C:\\x\\a.png', title: 'a', delivered: true })).toBe(true)
    expect(other.calls[0]?.[1]).toBe('dsh-resource://file/absolute/C:/x/a.png')
    expect(local.calls).toEqual([])
  })

  it('openFile 带 line / mode 时把导航参数交给 openResource；openTab 未注册的 kind 返回 false', () => {
    const { opener, calls } = make('local')
    expect(opener.openFile('src/a.ts', { line: 12, mode: 'edit' })).toBe(true)
    expect(calls[0]).toEqual(['resource', 'dsh-resource://file/session/local/src/a.ts', { revealIfOpened: true, params: { line: 12, mode: 'edit', nonce: 42 } }])
    expect(opener.openTab('git')).toBe(true)
    expect(opener.openTab('tasks')).toBe(false)
    expect(opener.openTab('sidechat')).toBe(false)
    expect(opener.openTab('ssh')).toBe(false)
    expect(opener.reveal('src')).toBe(true)
    expect(calls.at(-1)).toEqual(['tab', 'dsh-workspace:remote-files', { params: { reveal: '/C:/work/proj/src', nonce: 42 }, revealIfOpened: true }])
    expect(opener.openUrl('javascript:alert(1)')).toBe(false)
  })

  it('没有当前会话 / 没有侧栏服务时返回 false', () => {
    expect(make(undefined).opener.reveal('x')).toBe(false)
    const bare = createSidebarOpener({ index, right: () => undefined, hasKind: () => true, currentSession: () => 'local', filesKind: () => 'files' })
    expect(bare.openFile('a.md')).toBe(false)
    expect(bare.openTab('files')).toBe(false)
  })
})

describe('卡片辅助', () => {
  it('rowStateOf：进行中 / ok / 出错 / 中止', () => {
    expect(rowStateOf('preparing', {})).toBe('running')
    expect(rowStateOf('start', {})).toBe('running')
    expect(rowStateOf('result', { kind: 'result' })).toBe('ok')
    expect(rowStateOf('result', { kind: 'result', isError: true })).toBe('error')
    expect(rowStateOf('result', { kind: 'result', isError: true, error: { code: 'interrupted' } })).toBe('stopped')
  })

  it('targetOfArgs：完整 JSON 与生成中的半截 JSON 都能取到 target', () => {
    expect(targetOfArgs('{"target":"C:\\\\a\\\\b.md","title":"x"}')).toBe('C:\\a\\b.md')
    expect(targetOfArgs('{"target":"src/ma')).toBe('src/ma')
    expect(targetOfArgs('{"title":"x"}')).toBeUndefined()
    expect(targetOfArgs(undefined)).toBeUndefined()
  })

  it('navOf：取 line / mode，导航身份随 revision / nonce 变化', () => {
    expect(navOf(undefined)).toBeUndefined()
    expect(navOf({ params: { reveal: '/x' } })).toBeUndefined()
    expect(navOf({ params: { line: 3, mode: 'edit', nonce: 7 }, revision: 2 })).toEqual({ line: 3, mode: 'edit', key: '2|7' })
    expect(navOf({ params: { line: 0, mode: 'bad' } })).toBeUndefined()
  })
})
