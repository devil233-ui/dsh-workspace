/*
 * @Description: 文件夹地址处理的单测 —— 目录探测走哪个接口、定位 / 工作区外的分支判断
 * @Author: YangHeng
 * @Date: 2026-10-12 14:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/folder-redirect.test.ts
 */
import { describe, expect, it } from 'vitest'
import { folderAction, probeDirectory } from './folder-redirect.js'
import { revealParams } from './open-in-sidebar.js'

function fakeApi(handler: (method: string, payload: Record<string, unknown>) => unknown) {
  const calls: Array<[string, Record<string, unknown>]> = []
  return {
    calls,
    api: {
      call: async (method: string, payload: Record<string, unknown>) => {
        calls.push([method, payload])
        return handler(method, payload)
      }
    } as never
  }
}

describe('probeDirectory', () => {
  it('远程主机：sftpDirStamps 返回 mtime 即目录，null 即文件 / 不存在', async () => {
    const { api, calls } = fakeApi((_m, p) => ({ stamps: { [(p.paths as string[])[0] as string]: (p.paths as string[])[0] === '/srv/app/src' ? 123 : null } }))
    expect(await probeDirectory(api, 'h1', '/srv/app/src')).toBe(true)
    expect(await probeDirectory(api, 'h1', '/srv/app/a.ts')).toBe(false)
    expect(calls[0]).toEqual(['sftpDirStamps', { hostId: 'h1', paths: ['/srv/app/src'] }])
  })

  it('本机工作区内（local:<会话>）同样走 sftpDirStamps', async () => {
    const { api, calls } = fakeApi(() => ({ stamps: { '/C:/w/src': 1 } }))
    expect(await probeDirectory(api, 'local:s1', '/C:/w/src')).toBe(true)
    expect(calls[0]?.[0]).toBe('sftpDirStamps')
  })

  it('本机工作区外（local:*）：localList 用原生路径，能列出即目录', async () => {
    const { api, calls } = fakeApi(() => ({ path: 'C:\\Users\\me\\Downloads', home: '', entries: [], truncated: false }))
    expect(await probeDirectory(api, 'local:*', '/C:/Users/me/Downloads')).toBe(true)
    expect(calls[0]).toEqual(['localList', { path: 'C:\\Users\\me\\Downloads' }])
  })

  it('任何失败都按「不是目录」处理（保持查看器原有错误提示）', async () => {
    const { api } = fakeApi(() => {
      throw new Error('ENOTDIR')
    })
    expect(await probeDirectory(api, 'local:*', '/home/me/a.txt')).toBe(false)
    expect(await probeDirectory(api, 'h1', '/srv/x')).toBe(false)
  })
})

describe('folderAction', () => {
  it('远程：根下的文件夹定位，根本身只打开不定位，根外提示', () => {
    expect(folderAction('/srv/app', '/srv/app/src/lib', false)).toEqual({ kind: 'reveal', target: '/srv/app/src/lib' })
    expect(folderAction('/srv/app/', '/srv/app', false)).toEqual({ kind: 'reveal', target: undefined })
    expect(folderAction('/srv/app', '/srv/application', false)).toEqual({ kind: 'outside' })
    expect(folderAction('/srv/app', '/etc', false)).toEqual({ kind: 'outside' })
    expect(folderAction('/', '/etc', false)).toEqual({ kind: 'reveal', target: '/etc' })
  })

  it('没有可用工作区（会话无 cwd / 主机不同）一律提示', () => {
    expect(folderAction(undefined, '/srv/app/src', false)).toEqual({ kind: 'outside' })
    expect(folderAction(undefined, '/C:/w/src', true)).toEqual({ kind: 'outside' })
  })

  it('本机：Windows 盘符不区分大小写，定位路径沿用根的写法', () => {
    expect(folderAction('/C:/Work/proj', '/c:/work/proj/src', true)).toEqual({ kind: 'reveal', target: '/C:/Work/proj/src' })
    expect(folderAction('C:\\Work\\proj', '/C:/Work/proj', true)).toEqual({ kind: 'reveal', target: undefined })
    expect(folderAction('/C:/Work/proj', '/C:/Work/other', true)).toEqual({ kind: 'outside' })
  })

  it('本机 POSIX（macOS / Linux）区分大小写', () => {
    expect(folderAction('/Users/me/proj', '/Users/me/proj/docs', true)).toEqual({ kind: 'reveal', target: '/Users/me/proj/docs' })
    expect(folderAction('/Users/me/proj', '/users/me/proj/docs', true)).toEqual({ kind: 'outside' })
  })

  it('目标就是工作区根（各种写法）：只打开文件管理，不定位、不报错', () => {
    for (const p of ['/C:/TestChat', '/C:/TestChat/', 'C:/TestChat/', 'c:\\TestChat', 'c:\\testchat\\', '/C:/TestChat/./', 'C://TestChat//', '/C:/TestChat/aaa/..']) {
      expect(folderAction('/C:/TestChat', p, true), p).toEqual({ kind: 'reveal', target: undefined })
    }
    for (const p of ['/home/ps/testdsh/', '/home/ps/testdsh', '/home/ps/testdsh/.', '/home/ps//testdsh//']) {
      expect(folderAction('/home/ps/testdsh', p, false), p).toEqual({ kind: 'reveal', target: undefined })
    }
    expect(folderAction('/home/me/Proj/', '/home/me/Proj', true)).toEqual({ kind: 'reveal', target: undefined })
  })

  it('不能跳出工作区：.. 逃逸、前缀相似目录（TestChat2）、换盘符一律提示；子路径规范化后定位', () => {
    expect(folderAction('/C:/TestChat', '/C:/TestChat2', true)).toEqual({ kind: 'outside' })
    expect(folderAction('/C:/TestChat', 'c:\\testchat2\\sub', true)).toEqual({ kind: 'outside' })
    expect(folderAction('/C:/TestChat', '/C:/TestChat/../TestChat2', true)).toEqual({ kind: 'outside' })
    expect(folderAction('/C:/TestChat', '/C:/TestChat/aaa/../../Windows', true)).toEqual({ kind: 'outside' })
    expect(folderAction('/C:/TestChat', '/D:/TestChat', true)).toEqual({ kind: 'outside' })
    expect(folderAction('/C:/TestChat', 'c:\\testchat\\aaa\\\\bbb\\', true)).toEqual({ kind: 'reveal', target: '/C:/TestChat/aaa/bbb' })
    expect(folderAction('/home/ps/testdsh', '/home/ps/testdsh/../testdsh2', false)).toEqual({ kind: 'outside' })
    expect(folderAction('/home/ps/testdsh', '/home/ps/testdsh2', false)).toEqual({ kind: 'outside' })
    expect(folderAction('/home/ps/testdsh', '/home/ps/testdsh/./a//b/', false)).toEqual({ kind: 'reveal', target: '/home/ps/testdsh/a/b' })
    // Linux 区分大小写：只差大小写不算工作区内
    expect(folderAction('/home/ps/testdsh', '/home/ps/TestDsh', false)).toEqual({ kind: 'outside' })
    expect(folderAction('/home/me/Proj', '/home/me/proj/a', true)).toEqual({ kind: 'outside' })
  })
})

describe('revealParams', () => {
  it('文件夹：定位 + 展开；根本身不带 reveal / expand', () => {
    expect(revealParams('/srv/app/src', true, 7)).toEqual({ reveal: '/srv/app/src', expand: true, nonce: 7 })
    expect(revealParams('/srv/app/a.ts', false, 7)).toEqual({ reveal: '/srv/app/a.ts', nonce: 7 })
    expect(revealParams(undefined, true, 7)).toEqual({ nonce: 7 })
  })
})
