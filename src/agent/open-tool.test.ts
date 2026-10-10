/*
 * @Description: open_in_sidebar 宿主端单测 —— 目标分类（网址 / 盘符 / 相对路径 / 拒绝协议 / 远程路径判断）与执行结果
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/agent/open-tool.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteBinding } from '../workspace/bindings.js'
import { FakeBackend } from './fake-backend.js'
import { executeOpen, planOpenTarget, type OpenToolDeps } from './open-tool.js'
import { formatOpenResult, hasOtherScheme, parseOpenResult } from '../wire/open-in-sidebar.js'

const binding: RemoteBinding = {
  localPath: path.resolve('/tmp-dshws-placeholder/app'),
  hostId: 'h1',
  remotePath: '/srv/app',
  title: 'app',
  createdAt: '2026-10-10T00:00:00.000Z'
}

let sandbox: string
beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'dshws-open-'))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('planOpenTarget', () => {
  it('http(s) → 网址，标题取主机名；非法网址报错', async () => {
    expect(await planOpenTarget('https://example.com/a?b=1', {})).toEqual({ type: 'url', url: 'https://example.com/a?b=1', title: 'example.com' })
    expect(await planOpenTarget('  HTTP://localhost:5173/  ', {})).toMatchObject({ type: 'url', title: 'localhost' })
    await expect(planOpenTarget('http://[bad', {})).rejects.toThrow(/not a valid URL/)
  })

  it('拒绝其他协议；盘符不算协议', async () => {
    for (const raw of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://file/x', 'ftp://h/x']) {
      await expect(planOpenTarget(raw, { cwd: sandbox })).rejects.toThrow(/only accepts http/)
    }
    expect(hasOtherScheme('C:\\x\\y')).toBe(false)
    expect(hasOtherScheme('C:/x/y')).toBe(false)
    if (process.platform === 'win32') {
      expect(await planOpenTarget('C:\\x\\y.md', { cwd: sandbox })).toEqual({ type: 'local', path: 'C:\\x\\y.md' })
    }
  })

  it('本机会话：相对路径相对 cwd，绝对路径原样；没有 cwd 的相对路径报错；空目标报错', async () => {
    expect(await planOpenTarget('docs/a.md', { cwd: sandbox })).toEqual({ type: 'local', path: path.join(sandbox, 'docs', 'a.md') })
    expect(await planOpenTarget(path.join(sandbox, 'b.md'), { cwd: '/elsewhere' })).toEqual({ type: 'local', path: path.join(sandbox, 'b.md') })
    await expect(planOpenTarget('a.md', {})).rejects.toThrow(/no working directory/)
    await expect(planOpenTarget('   ', { cwd: sandbox })).rejects.toThrow(/non-empty/)
  })

  it('远程会话：相对路径 / 远程绝对路径 / 占位目录路径都按远程根解析', async () => {
    const opts = { binding, cwd: binding.localPath }
    expect(await planOpenTarget('src/main.ts', opts)).toEqual({ type: 'remote', remotePath: '/srv/app/src/main.ts' })
    expect(await planOpenTarget('/srv/app/README.md', opts)).toEqual({ type: 'remote', remotePath: '/srv/app/README.md' })
    expect(await planOpenTarget(path.join(binding.localPath, 'lib', 'x.js'), opts)).toEqual({ type: 'remote', remotePath: '/srv/app/lib/x.js' })
    expect(await planOpenTarget('../other', opts)).toEqual({ type: 'remote', remotePath: '/srv/other' })
  })

  it('远程会话的跨平台判定：Windows 只认盘符 / UNC 为本机；非 Windows 对根外 / 开头路径做本机存在 + 远端不存在判断', async () => {
    // Windows 宿主：/ 开头一律远程（即使本机「存在」）。
    expect(
      await planOpenTarget('/Users/me/a.png', { binding, platform: 'win32', localExists: () => true, remoteExists: async () => false })
    ).toEqual({ type: 'remote', remotePath: '/Users/me/a.png' })
    // macOS / Linux：根外、本机存在、远端不存在 → 本机。
    expect(
      await planOpenTarget('/Users/me/a.png', { binding, platform: 'darwin', localExists: () => true, remoteExists: async () => false })
    ).toMatchObject({ type: 'local' })
    // 远端也存在 → 远程；本机不存在 → 远程。
    expect(
      await planOpenTarget('/Users/me/a.png', { binding, platform: 'darwin', localExists: () => true, remoteExists: async () => true })
    ).toEqual({ type: 'remote', remotePath: '/Users/me/a.png' })
    expect(
      await planOpenTarget('/opt/x', { binding, platform: 'linux', localExists: () => false, remoteExists: async () => false })
    ).toEqual({ type: 'remote', remotePath: '/opt/x' })
    // 远程根下的路径没有歧义：不做存在性判断。
    expect(
      await planOpenTarget('/srv/app/a', { binding, platform: 'linux', localExists: () => true, remoteExists: async () => false })
    ).toEqual({ type: 'remote', remotePath: '/srv/app/a' })
    if (process.platform === 'win32') {
      expect(await planOpenTarget('D:\\shots\\a.png', { binding })).toEqual({ type: 'local', path: 'D:\\shots\\a.png' })
    }
  })
})

describe('executeOpen', () => {
  const exec = (cwd: string) => ({ agent: { session: { header: { cwd } } }, signal: new AbortController().signal })

  it('本机：文件 / 文件夹按 stat 区分，标题默认取文件名，自定义标题优先；不存在报错', async () => {
    mkdirSync(path.join(sandbox, 'docs'))
    writeFileSync(path.join(sandbox, 'docs', 'a.md'), '# a')
    const deps: OpenToolDeps = { resolveBinding: () => undefined, remoteStat: async () => undefined }
    expect(await executeOpen(deps, { target: 'docs/a.md' }, exec(sandbox))).toEqual({
      kind: 'file',
      target: path.join(sandbox, 'docs', 'a.md'),
      title: 'a.md',
      delivered: true
    })
    expect(await executeOpen(deps, { target: 'docs', title: ' 文档 ' }, exec(sandbox))).toMatchObject({ kind: 'folder', title: '文档' })
    await expect(executeOpen(deps, { target: 'nope.md' }, exec(sandbox))).rejects.toThrow(/does not exist/)
    expect(await executeOpen(deps, { target: 'https://example.com' }, exec(sandbox))).toEqual({
      kind: 'url',
      target: 'https://example.com',
      title: 'example.com',
      delivered: true
    })
  })

  it('远程：SFTP stat 区分文件 / 文件夹，结果带 remoteHost；不存在报错；会话不在远程工作区时按本机处理', async () => {
    const backend = new FakeBackend()
    backend.addDir('/srv/app')
    backend.addDir('/srv/app/src')
    backend.put('/srv/app/src/main.ts', 'x')
    const deps: OpenToolDeps = {
      resolveBinding: (cwd) => (cwd === binding.localPath ? binding : undefined),
      remoteStat: (_b, p) => backend.stat(p)
    }
    expect(await executeOpen(deps, { target: 'src/main.ts' }, exec(binding.localPath))).toEqual({
      kind: 'file',
      target: '/srv/app/src/main.ts',
      title: 'main.ts',
      delivered: true,
      remoteHost: 'h1'
    })
    expect(await executeOpen(deps, { target: '/srv/app/src' }, exec(binding.localPath))).toMatchObject({ kind: 'folder', remoteHost: 'h1' })
    await expect(executeOpen(deps, { target: 'missing.ts' }, exec(binding.localPath))).rejects.toThrow(/does not exist on the remote host/)
  })

  it('没有发起 Agent → 报错', async () => {
    const deps: OpenToolDeps = { resolveBinding: () => undefined, remoteStat: async () => undefined }
    await expect(executeOpen(deps, { target: 'a' }, {})).rejects.toThrow(/initiating agent/)
  })
})

describe('结果文本', () => {
  it('formatOpenResult / parseOpenResult 往返一致；不是本插件格式的文本解析为 undefined', () => {
    const value = { kind: 'folder' as const, target: '/srv/app/src', title: 'src "x"\nnew', delivered: true, remoteHost: 'h1' }
    const text = formatOpenResult(value)
    expect(text.split('\n')[0]).toContain('Opened folder')
    expect(parseOpenResult(text)).toEqual(value)
    expect(parseOpenResult('Opened file "a" (C:\\a) in the sidebar.')).toBeUndefined()
    expect(parseOpenResult('dsh-workspace:open {"kind":"exe","target":"x"}')).toBeUndefined()
    expect(parseOpenResult('dsh-workspace:open {broken')).toBeUndefined()
  })
})
