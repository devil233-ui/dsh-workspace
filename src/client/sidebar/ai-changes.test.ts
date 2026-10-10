/*
 * @Description: 「AI 改动」浏览器端纯函数的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/ai-changes.test.ts
 */
import { describe, expect, it } from 'vitest'
import { filesInScope, repoRelative, turnCount } from './ai-changes.js'
import type { AiChangesResult } from '../../wire/ai-changes.js'

const data: AiChangesResult = {
  available: true,
  turn: 3,
  files: [
    { path: '/srv/app/a.ts', ops: 2, turnOps: 1, last: 'edit', lastSeq: 9 },
    { path: '/srv/app/b.ts', ops: 1, turnOps: 0, last: 'write', lastSeq: 4 }
  ]
}

describe('filesInScope / turnCount', () => {
  it('本轮只取 turnOps > 0；全部原样', () => {
    expect(filesInScope(data, 'turn').map((f) => f.path)).toEqual(['/srv/app/a.ts'])
    expect(filesInScope(data, 'all')).toHaveLength(2)
    expect(turnCount(data)).toBe(1)
    expect(turnCount(null)).toBe(0)
  })
})

describe('repoRelative', () => {
  it('仓库内返回相对路径，仓库外 / 根本身返回 undefined', () => {
    expect(repoRelative('/srv/app', '/srv/app/src/a.ts')).toBe('src/a.ts')
    expect(repoRelative('/srv/app/', '/srv/app/a.ts')).toBe('a.ts')
    expect(repoRelative('/srv/app', '/srv/apple/a.ts')).toBeUndefined()
    expect(repoRelative('/srv/app', '/srv/app')).toBeUndefined()
    expect(repoRelative('/', '/etc/hosts')).toBe('etc/hosts')
  })

  it('本地 Windows 路径不区分大小写，返回值保留原写法', () => {
    expect(repoRelative('/C:/Work/Repo', '/c:/work/repo/Src/A.ts')).toBe('Src/A.ts')
    // Linux 区分大小写
    expect(repoRelative('/home/Me', '/home/me/a.ts')).toBeUndefined()
  })
})
