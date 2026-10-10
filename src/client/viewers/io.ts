/*
 * @Description: 查看器的文件读写通道 —— 远程（SFTP）/ 本机工作区（local:<会话>）/ 本机任意路径只读（local:*）统一成一套接口
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/viewers/io.ts
 *
 * 线上路径一律是 POSIX 形式（远程绝对路径 / 本地 POSIX 形式 /C:/x）。
 * 本机读取不分工作区内外都走 localRead / localReadData（任意路径只读）；写入只走 sftpWrite + local:<会话>，
 * 宿主按会话 cwd 推导根目录并做 realpath 防逃逸 —— 浏览器这边的「可写」判断只决定按钮显示，不是安全边界。
 */
import type { WorkspaceApi } from '../api.js'
import { LOCAL_ANY_HOST } from '../../wire/contract.js'
import type { ReadResult } from '../../wire/dto.js'
import { downloadUrl, startDownload } from '../files/transfer.js'

export interface FileIO {
  hostId: string
  path: string
  local: boolean
  /** 可保存（远程文件，或当前本机会话工作区内的文件）。 */
  writable: boolean
  readText(): Promise<ReadResult>
  /** 读任意文件为 base64（预览内联资源用）。 */
  readData(p: string): Promise<string>
  /** 按文本读任意文件（内联资源的退路）。 */
  readTextOf(p: string): Promise<ReadResult>
  write(content: string, expectedMtime: number | undefined): Promise<{ size: number; mtime: number }>
  /** 预览路由地址（令牌绑定工作区根）；工作区外的本机文件没有，返回 undefined（调用方改走内联）。 */
  previewUrl(p: string, trusted?: boolean): Promise<string | undefined>
  /** 流式读取地址（支持 Range；inline=1 时图片 / 音视频 / PDF 按真实类型返回）。 */
  streamUrl(): string
  download(): void
}

export function isLocalHost(hostId: string): boolean {
  return hostId.startsWith('local:')
}

export function fileIO(api: WorkspaceApi, hostId: string, path: string): FileIO {
  const local = isLocalHost(hostId)
  const scoped = local && hostId !== LOCAL_ANY_HOST
  /**
   * 本机读取优先走 localRead（不限工作区）；工作区内的文件在它失败时退回旧通道 sftpRead(local:<会话>)——
   * 插件刚升级、DSH 后台还是旧版本时（只刷新页面不会更新后台）新方法不存在，工作区内的文件至少照常能看。
   */
  const readText = async (p: string): Promise<ReadResult> => {
    if (!local) return api.call('sftpRead', { hostId, path: p })
    try {
      return await api.call('localRead', { path: p })
    } catch (error) {
      if (!scoped) throw error
      return api.call('sftpRead', { hostId, path: p })
    }
  }
  const readData = async (p: string): Promise<string> => {
    if (!local) return (await api.call('sftpReadData', { hostId, path: p })).base64
    try {
      return (await api.call('localReadData', { path: p })).base64
    } catch (error) {
      if (!scoped) throw error
      return (await api.call('sftpReadData', { hostId, path: p })).base64
    }
  }
  return {
    hostId,
    path,
    local,
    writable: hostId !== LOCAL_ANY_HOST,
    readText: () => readText(path),
    readData,
    readTextOf: readText,
    write: (content, expectedMtime) =>
      api.call('sftpWrite', { hostId, path, content, ...(expectedMtime !== undefined ? { expectedMtime } : {}) }),
    previewUrl: async (p, trusted) => {
      if (hostId === LOCAL_ANY_HOST) return undefined
      try {
        return (await api.call('previewUrl', { hostId, path: p, ...(trusted === true ? { trusted: true } : {}) })).url
      } catch (error) {
        // 本机：文件在工作区外（例如经 @ 引用打开的 Git 工作目录外文件）—— 交给内联。
        if (local) return undefined
        throw error
      }
    },
    streamUrl: () => `${downloadUrl(hostId, path)}&inline=1`,
    download: () => startDownload(hostId, path)
  }
}
