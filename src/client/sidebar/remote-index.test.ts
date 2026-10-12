/*
 * @Description: 右侧栏远程会话判定测试 —— 地址解析、路径映射、按会话查远程工作区
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/remote-index.test.ts
 */
import { describe, expect, it } from 'vitest'
import { RemoteIndex, displayPath, isInsideLocal, localFileAddress, localSessionAddress, normalizePosix, parseFileAddress, revealPlan, sessionFileAddress, toLocalPosix, toRemotePath } from './remote-index.js'
import { centeredScrollTop } from './VirtualList.js'

describe('显示文件位置：定位计划与滚动', () => {
  it('展开从根到父目录的每一级；点开头的段需要显示隐藏文件；根外 / 根本身不定位', () => {
    expect(revealPlan('/srv/app', '/srv/app/public/img/a.png')).toEqual({ dirs: ['/srv/app/public', '/srv/app/public/img'], hidden: false, target: '/srv/app/public/img/a.png' })
    expect(revealPlan('/srv/app/', '/srv/app/a.png')).toEqual({ dirs: [], hidden: false, target: '/srv/app/a.png' })
    expect(revealPlan('/srv/app', '/srv/app/.github/wf.yml')).toEqual({ dirs: ['/srv/app/.github'], hidden: true, target: '/srv/app/.github/wf.yml' })
    expect(revealPlan('/', '/etc/hosts')).toEqual({ dirs: ['/etc'], hidden: false, target: '/etc/hosts' })
    expect(revealPlan('/srv/app', '/srv/apple/a')).toBeUndefined()
    expect(revealPlan('/srv/app', '/srv/app')).toBeUndefined()
  })

  it('目标行居中，靠顶部时不出现负值', () => {
    const offsets = [0, 26, 52, 78, 104, 130]
    expect(centeredScrollTop(offsets, 4, 52, 0)).toBe(91)
    expect(centeredScrollTop(offsets, 0, 520, 0)).toBe(0)
    expect(centeredScrollTop(offsets, 4, 52, 40)).toBe(131)
  })
})

const ws = {
  localPath: 'C:\\Users\\yangheng\\.dsh\\workspaces\\remote\\192.168.3.112-ps-22\\测试DSH远程',
  hostId: 'h1',
  remotePath: '/home/ps/testdsh',
  title: '测试DSH远程'
}

function indexWith(sessions: Record<string, { cwd?: string }>) {
  const index = new RemoteIndex(async () => [ws], () => ({ list: { getSnapshot: () => ({ byId: sessions }), subscribe: () => () => undefined } }))
  return index
}

describe('文件地址', () => {
  it('DSH 生成的会话地址（远程绝对路径保留前导 /，中文逐段编码）可往返', () => {
    const addr = sessionFileAddress('session-1', '/home/ps/testdsh/calculator/index.html')
    expect(addr).toBe('dsh-resource://file/session/session-1//home/ps/testdsh/calculator/index.html')
    expect(parseFileAddress(addr)).toEqual({ scope: 'session', sessionId: 'session-1', path: '/home/ps/testdsh/calculator/index.html' })
    expect(parseFileAddress(sessionFileAddress('s', '文档/说明.md'))?.path).toBe('文档/说明.md')
  })

  it('absolute 地址：盘符与 POSIX', () => {
    expect(parseFileAddress('dsh-resource://file/absolute/C:/x/y.txt')?.path).toBe('C:/x/y.txt')
    expect(parseFileAddress('dsh-resource://file/absolute/home/a')?.path).toBe('/home/a')
    expect(parseFileAddress('https://x')).toBeUndefined()
  })
})

describe('路径映射', () => {
  it('远程绝对路径原样；相对路径接到远程根；.. 折叠', () => {
    expect(toRemotePath(ws, '/home/ps/testdsh/app.js')).toBe('/home/ps/testdsh/app.js')
    expect(toRemotePath(ws, 'calculator/index.html')).toBe('/home/ps/testdsh/calculator/index.html')
    expect(toRemotePath(ws, 'a/../b')).toBe('/home/ps/testdsh/b')
    expect(normalizePosix('/a/./b/../c')).toBe('/a/c')
  })

  it('占位目录下的本机路径换成远程路径（大小写、斜杠方向不敏感）；其他本机路径不属于该工作区', () => {
    expect(toRemotePath(ws, 'c:/users/yangheng/.dsh/workspaces/remote/192.168.3.112-ps-22/测试DSH远程/x/y.ts')).toBe('/home/ps/testdsh/x/y.ts')
    expect(toRemotePath(ws, 'C:\\home\\ps\\testdsh\\app.js')).toBeUndefined()
  })

  it('macOS / Linux：占位目录本身以 / 开头，也要先换成远程路径（不能当远程路径原样发出去）', () => {
    const mac = { ...ws, localPath: '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app' }
    expect(toRemotePath(mac, '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/src/a.ts')).toBe('/home/ps/testdsh/src/a.ts')
    expect(toRemotePath(mac, '/Users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app')).toBe('/home/ps/testdsh')
    // 真正的远程绝对路径照旧
    expect(toRemotePath(mac, '/home/ps/testdsh/b.ts')).toBe('/home/ps/testdsh/b.ts')
    // Linux 区分大小写：只差大小写的路径不算占位目录
    expect(toRemotePath(mac, '/users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/x')).toBe('/users/me/.dsh/workspaces/remote/192.168.3.112-ps-22/app/x')
  })
})

describe('RemoteIndex', () => {
  it('只有远程工作区的会话里的地址才被认领（这是修「点开文件读 C 盘」的判定）', async () => {
    const index = indexWith({ remote: { cwd: ws.localPath }, local: { cwd: 'C:\\DshChat' } })
    await index.refresh()
    const hit = index.resolveAddress(sessionFileAddress('remote', '/home/ps/testdsh/calculator/index.html'))
    expect(hit?.remotePath).toBe('/home/ps/testdsh/calculator/index.html')
    expect(hit?.workspace.hostId).toBe('h1')
    expect(index.resolveAddress(sessionFileAddress('local', '/home/ps/testdsh/app.js'))).toBeUndefined()
    expect(index.resolveAddress(sessionFileAddress('unknown', 'a.txt'))).toBeUndefined()
    expect(index.bySession('remote')?.title).toBe('测试DSH远程')
  })

  it('远程会话里交付的本机文件（盘符路径）不认领，交回宿主预览', async () => {
    const index = indexWith({ remote: { cwd: ws.localPath } })
    await index.refresh()
    // 宿主 fileAddressFor 对本机盘符路径生成的就是这种地址。
    expect(index.resolveAddress('dsh-resource://file/session/remote/C:/DshChat/pic/a.png')).toBeUndefined()
    expect(index.resolveAddress(sessionFileAddress('remote', '/home/ps/testdsh/public/a.png'))?.remotePath).toBe('/home/ps/testdsh/public/a.png')
  })

  it('列表内容没变时不通知、沿用旧对象（否则远程 Git 面板会反复整页重载并关掉预览）', async () => {
    let list = [{ ...ws }]
    const index = new RemoteIndex(async () => list.map((w) => ({ ...w })), () => ({ list: { getSnapshot: () => ({ byId: { s: { cwd: ws.localPath } } }), subscribe: () => () => undefined } }))
    let notified = 0
    index.subscribe(() => notified++)
    await index.refresh()
    const first = index.bySession('s')
    await index.refresh()
    await index.refresh()
    expect(notified).toBe(1)
    expect(index.bySession('s')).toBe(first)
    list = [{ ...ws, title: '改名' }]
    await index.refresh()
    expect(notified).toBe(2)
    expect(index.bySession('s')?.title).toBe('改名')
  })

  it('列表未加载 / 加载失败时一律不认领（交还原处理方，而不是报错）', async () => {
    const failing = new RemoteIndex(async () => {
      throw new Error('not ready')
    }, () => undefined)
    await failing.refresh()
    expect(failing.resolveAddress(sessionFileAddress('s', '/x'))).toBeUndefined()
  })
})

describe('本地工作区（文件管理 / Git 仓库）', () => {
  it('本地 POSIX 形式、显示路径、绝对文件地址', () => {
    expect(toLocalPosix('C:\\DshChat\\ws\\')).toBe('/C:/DshChat/ws')
    expect(toLocalPosix('D:\\')).toBe('/D:')
    expect(toLocalPosix('/home/me/p/')).toBe('/home/me/p')
    expect(displayPath('/C:/DshChat/ws/a.ts')).toBe('C:\\DshChat\\ws\\a.ts')
    expect(displayPath('/home/ps/a')).toBe('/home/ps/a')
    expect(localFileAddress('/C:/x/中 文.ts')).toBe('dsh-resource://file/absolute/C:/x/%E4%B8%AD%20%E6%96%87.ts')
    expect(parseFileAddress(localFileAddress('/C:/x/a.ts'))).toEqual({ scope: 'absolute', path: 'C:/x/a.ts' })
    expect(parseFileAddress(localFileAddress('/home/a'))).toEqual({ scope: 'absolute', path: '/home/a' })
  })

  it('workspaceFor：远程会话给远程工作区，本地会话给 local:<会话 id>；对象稳定；bySession 仍只认远程', async () => {
    const index = indexWith({ r: { cwd: `${ws.localPath}\\sub` }, l: { cwd: 'C:\\DshChat\\proj' }, n: {} })
    await index.refresh()
    expect(index.workspaceFor('r')).toMatchObject({ hostId: 'h1', remotePath: '/home/ps/testdsh', local: false })
    const local = index.workspaceFor('l')
    expect(local).toEqual({ localPath: 'C:\\DshChat\\proj', hostId: 'local:l', remotePath: '/C:/DshChat/proj', title: 'proj', local: true })
    expect(index.workspaceFor('l')).toBe(local)
    expect(index.workspaceFor('n')).toBeUndefined()
    expect(index.bySession('l')).toBeUndefined()
    // 本插件的远程文件查看器不认领本地文件（交给宿主 / 其他插件的查看器）
    expect(index.resolveAddress(localFileAddress('/C:/DshChat/proj/a.ts'))).toBeUndefined()
  })
})
describe('本机文件地址（查看器统一）', () => {
  it('session 范围：相对路径按 cwd 拼接，绝对路径原样；远程会话 / 无 cwd 的相对路径不认领', async () => {
    const index = indexWith({ s1: { cwd: 'C:\\DshChat\\proj' }, r: { cwd: ws.localPath }, none: {} })
    await index.refresh()
    expect(index.resolveLocalAddress(sessionFileAddress('s1', 'src/a.ts'))).toEqual({ path: '/C:/DshChat/proj/src/a.ts', sessionId: 's1', cwd: 'C:\\DshChat\\proj' })
    expect(index.resolveLocalAddress(sessionFileAddress('s1', 'D:/Downloads/a.pdf'))?.path).toBe('/D:/Downloads/a.pdf')
    expect(index.resolveLocalAddress(sessionFileAddress('s1', 'src/../b.md'))?.path).toBe('/C:/DshChat/proj/b.md')
    expect(index.resolveLocalAddress(sessionFileAddress('r', 'a.ts'))).toBeUndefined()
    expect(index.resolveLocalAddress(sessionFileAddress('none', 'a.ts'))).toBeUndefined()
  })

  it('absolute 范围：本机任意路径认领，远程占位目录里的交给远程解析', async () => {
    const index = indexWith({})
    await index.refresh()
    expect(index.resolveLocalAddress('dsh-resource://file/absolute/D:/x/a.png')).toEqual({ path: '/D:/x/a.png' })
    expect(index.resolveLocalAddress('dsh-resource://file/absolute/home/me/a.md')).toEqual({ path: '/home/me/a.md' })
    expect(index.resolveLocalAddress(localFileAddress(toLocalPosix(`${ws.localPath}\\a.ts`)))).toBeUndefined()
  })

  it('localSessionAddress 与宿主 fileAddressFor 一致：工作区内用相对路径，工作区外用绝对路径', () => {
    expect(localSessionAddress('s1', 'C:\\DshChat\\proj', '/C:/DshChat/proj/src/a b.ts')).toBe(sessionFileAddress('s1', 'src/a b.ts'))
    expect(localSessionAddress('s1', 'C:\\DshChat\\proj', '/D:/x/a.ts')).toBe(sessionFileAddress('s1', 'D:/x/a.ts'))
    expect(localSessionAddress('s1', '/home/me/proj', '/home/me/proj/a.ts')).toBe(sessionFileAddress('s1', 'a.ts'))
    expect(localSessionAddress('s1', undefined, '/home/me/a.ts')).toBe('dsh-resource://file/session/s1//home/me/a.ts')
  })

  it('isInsideLocal：Windows 不区分大小写，POSIX 区分；前缀相同的兄弟目录不算', () => {
    expect(isInsideLocal('C:\\DshChat\\proj', '/c:/dshchat/PROJ/a.ts')).toBe(true)
    expect(isInsideLocal('C:\\DshChat\\proj', '/C:/DshChat/project/a.ts')).toBe(false)
    expect(isInsideLocal('/home/me', '/home/Me/a')).toBe(false)
    expect(isInsideLocal('/home/me', '/home/me')).toBe(true)
  })
})
describe('工作区根本身与路径规范化（链接指向工作区根时报「path is required」的修复）', () => {
  const winCwd = 'C:/TestChat/'
  async function winIndex() {
    const index = indexWith({ w: { cwd: winCwd }, lx: { cwd: '/home/me/Proj' }, r: { cwd: ws.localPath } })
    await index.refresh()
    return index
  }

  it('宿主 fileAddressFor 对根生成空相对路径：.../session/<id>/ 与缺结尾 / 的地址都解析成空路径', () => {
    expect(parseFileAddress('dsh-resource://file/session/w/')).toEqual({ scope: 'session', sessionId: 'w', path: '' })
    expect(parseFileAddress('dsh-resource://file/session/w')).toEqual({ scope: 'session', sessionId: 'w', path: '' })
    expect(parseFileAddress('dsh-resource://file/session/w?x=1')).toEqual({ scope: 'session', sessionId: 'w', path: '' })
    expect(parseFileAddress('dsh-resource://file/session/')).toBeUndefined()
  })

  it('本机会话：根的各种写法都认领为工作区根（不再交给宿主查看器读空路径）', async () => {
    const index = await winIndex()
    for (const p of ['', '.', './', './/', 'C:/TestChat/', 'C:/TestChat', 'c:\\TestChat', 'c:\\testchat\\', 'C:/TestChat/./', 'C://TestChat//', 'C:/TestChat/aaa/..']) {
      const hit = index.resolveLocalAddress(sessionFileAddress('w', p.replace(/\\/g, '/')))
      expect(hit?.path.toLowerCase(), p).toBe('/c:/testchat')
      expect(isInsideLocal(winCwd, hit?.path ?? ''), p).toBe(true)
    }
    // 反斜杠写法原样进地址（不经 sessionFileAddress 规范化）也一样
    expect(index.resolveLocalAddress('dsh-resource://file/session/w/c:%5CTestChat%5C')?.path).toBe('/c:/TestChat')
  })

  it('本机会话：子路径规范化；.. 逃逸、前缀相似目录（TestChat2）不算工作区内', async () => {
    const index = await winIndex()
    expect(index.resolveLocalAddress(sessionFileAddress('w', 'aaa'))?.path).toBe('/C:/TestChat/aaa')
    expect(index.resolveLocalAddress(sessionFileAddress('w', './aaa//bbb/'))?.path).toBe('/C:/TestChat/aaa/bbb')
    const up = index.resolveLocalAddress(sessionFileAddress('w', '../TestChat2'))?.path as string
    expect(up).toBe('/C:/TestChat2')
    expect(isInsideLocal(winCwd, up)).toBe(false)
    expect(isInsideLocal(winCwd, '/C:/TestChat2/a')).toBe(false)
    expect(isInsideLocal(winCwd, '/C:/TestChat/../TestChat2')).toBe(false)
    // 盘符根之上的 .. 停在盘符，不会变成另一个 POSIX 路径
    expect(index.resolveLocalAddress(sessionFileAddress('w', '../../../x'))?.path).toBe('/C:/x')
    expect(normalizePosix('/C:/a/../../..')).toBe('/C:')
  })

  it('Linux / macOS 本机：/ 开头、区分大小写', async () => {
    const index = await winIndex()
    expect(index.resolveLocalAddress(sessionFileAddress('lx', ''))?.path).toBe('/home/me/Proj')
    expect(index.resolveLocalAddress(sessionFileAddress('lx', '/home/me/Proj/'))?.path).toBe('/home/me/Proj')
    expect(isInsideLocal('/home/me/Proj', '/home/me/proj')).toBe(false)
    expect(isInsideLocal('/home/me/Proj', '/home/me/Proj2')).toBe(false)
    expect(isInsideLocal('/home/me/Proj', '/home/me/Proj/../x')).toBe(false)
  })

  it('远程会话：链接指向远程根本身（含空路径 / . / 结尾斜杠 / 无斜杠）都解析到远程根', async () => {
    const index = await winIndex()
    for (const p of ['', '.', './', '/home/ps/testdsh/', '/home/ps/testdsh', '/home/ps/testdsh//./']) {
      expect(index.resolveAddress(sessionFileAddress('r', p))?.remotePath, p).toBe('/home/ps/testdsh')
    }
    expect(index.resolveAddress('dsh-resource://file/session/r')?.remotePath).toBe('/home/ps/testdsh')
    expect(index.resolveAddress(sessionFileAddress('r', '../testdsh2'))?.remotePath).toBe('/home/ps/testdsh2')
  })

  it('revealPlan：规范化后比较；根本身、.. 逃逸、前缀相似目录不定位；Windows 根只差大小写时沿用根的写法', () => {
    expect(revealPlan('/C:/TestChat', '/C:/TestChat/')).toBeUndefined()
    expect(revealPlan('/C:/TestChat', '/C:/TestChat2/a')).toBeUndefined()
    expect(revealPlan('/C:/TestChat', '/C:/TestChat/a/../../x')).toBeUndefined()
    expect(revealPlan('/C:/TestChat', '/c:/testchat/aaa/b.ts')).toEqual({ dirs: ['/C:/TestChat/aaa'], hidden: false, target: '/C:/TestChat/aaa/b.ts' })
    expect(revealPlan('/home/ps/testdsh', '/home/ps/testdsh/./a//b')).toEqual({ dirs: ['/home/ps/testdsh/a'], hidden: false, target: '/home/ps/testdsh/a/b' })
    expect(revealPlan('/home/ps/testdsh', '/home/ps/TestDsh/a')).toBeUndefined()
  })
})