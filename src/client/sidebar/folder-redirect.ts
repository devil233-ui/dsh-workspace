/*
 * @Description: 文件查看器遇到「文件夹」地址时的处理 —— 探测目标是否为目录、决定在「文件管理」里定位还是提示不在工作区内
 * @Author: YangHeng
 * @Date: 2026-10-12 14:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/folder-redirect.ts
 *
 * 为什么需要：宿主聊天的文件链接、dshWorkspace.openFile、交付卡片「打开」都只生成 dsh-resource://file/... 地址交给右侧栏，
 * 宿主打开前并不知道目标是文件还是文件夹；文件夹被本插件查看器认领后读文件失败，只会显示「只能预览普通文件」。
 * 所以查看器打开时先探测一次：是目录就改开「文件管理」并定位展开（与 open_in_sidebar 的文件夹分支同一套导航参数）。
 *
 * 探测只用已有接口（不新增 RPC，避免「插件已升级但 DSH 后台仍是旧版本」时整体失效）：
 * - 远程主机 / 本机工作区（local:<会话>）：sftpDirStamps —— 目录返回 mtime，文件 / 不存在 / 无权限返回 null；
 * - 本机工作区外（local:*）：localList（任意本机绝对路径的子目录列表）—— 能列出即目录，失败即不是目录或读不了。
 */
import type { WorkspaceApi } from '../api.js'
import { LOCAL_ANY_HOST } from '../../wire/contract.js'
import { displayPath, isInsideLocal, normalizeLocalPosix, normalizePosix } from './remote-index.js'

/**
 * 目标是不是目录。任何失败（不存在、无权限、旧后台缺接口、网络）都返回 false：
 * 交还查看器按文件处理，原有的错误提示保持不变。
 */
export async function probeDirectory(api: Pick<WorkspaceApi, 'call'>, hostId: string, path: string): Promise<boolean> {
  try {
    if (hostId === LOCAL_ANY_HOST) {
      // localList 要宿主机原生绝对路径：/C:/x → C:\x；macOS / Linux 原样。
      await api.call('localList', { path: displayPath(path) })
      return true
    }
    const { stamps } = await api.call('sftpDirStamps', { hostId, paths: [path] })
    return typeof stamps[path] === 'number'
  } catch {
    return false
  }
}

/** 文件夹的处理方式。reveal.target 为 undefined = 就是工作区根，打开「文件管理」即可（根本身无需定位）。 */
export type FolderAction = { kind: 'reveal'; target: string | undefined } | { kind: 'outside' }

/**
 * 决定文件夹怎么处理（纯函数）。
 * 先规范化（统一分隔符、折叠 . 与 ..、去重复 / 结尾斜杠）再比较，且前缀比较带 / 边界：
 * 否则 /srv/app/../etc 会被当成工作区内、C:/TestChat2 会被当成 C:/TestChat 的子目录，文件树里定位到工作区外。
 * @param root 标签所在会话的「文件管理」根（远程绝对路径 / 本地 POSIX 形式）；会话没有可用工作区时为 undefined。
 * @param path 文件夹路径（同上写法）。
 * @param local 是否本机路径：本机按 Windows 盘符不区分大小写比较，并把定位路径换成根的大小写（文件树按根拼接路径）。
 */
export function folderAction(root: string | undefined, path: string, local: boolean): FolderAction {
  if (root === undefined || root === '') return { kind: 'outside' }
  const base = local ? normalizeLocalPosix(root) : normalizePosix(root)
  const target = local ? normalizeLocalPosix(path) : normalizePosix(path)
  const inside = local ? isInsideLocal(base, target) : base === '/' || target === base || target.startsWith(`${base}/`)
  if (!inside) return { kind: 'outside' }
  // 只差大小写（C:/Work vs c:/work）时长度相同：沿用根的写法拼出剩余部分，文件树的定位按字符串前缀匹配。
  const rest = target.slice(base === '/' ? 1 : base.length).replace(/^\//, '')
  return { kind: 'reveal', target: rest === '' ? undefined : `${base === '/' ? '' : base}/${rest}` }
}
