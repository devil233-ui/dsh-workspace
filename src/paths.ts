/*
 * @Description: 插件本地数据目录解析（不碰旧的 remote-workspaces/）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/paths.ts
 */
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * DSH 家目录。优先级与宿主 dsh-home-paths 一致：
 * $DSH_HOME > ~/.dsh。这里不依赖宿主包，避免为一个路径引入 peer 依赖。
 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(homedir(), '.dsh')
}

/**
 * 本插件的数据根目录。
 * 刻意区别于 dsh-remote 的 `remote-workspaces/`：两套 meta 格式不同，
 * 共用目录会互相破坏，且开发期需要保留旧插件作为退路。
 */
export function pluginRoot(): string {
  return path.join(dshHome(), 'workspaces')
}

/** 主机库与分组的持久化文件。 */
export function vaultFile(): string {
  return path.join(pluginRoot(), 'vault.json')
}

/** 自动解锁：本机记住的主密钥（Windows 下经 DPAPI 加密）。删除即关闭自动解锁。 */
export function autoUnlockFile(): string {
  return path.join(pluginRoot(), 'vault.autounlock')
}

/** 已知主机指纹（TOFU）。 */
export function knownHostsFile(): string {
  return path.join(pluginRoot(), 'known-hosts.json')
}

/** workspaceId → 主机映射表。 */
export function bindingsFile(): string {
  return path.join(pluginRoot(), 'bindings.json')
}

/** 上次运行时打开着的终端（只含主机与标题，不含任何输出内容）。 */
export function terminalsFile(): string {
  return path.join(pluginRoot(), 'terminals.json')
}

/** 把任意字符串压成可安全用作目录名的形式。 */
export function safeSegment(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9._-]/g, '_')
  return cleaned === '' ? '_' : cleaned
}

/** 工作区目录内的 meta 文件名（映射表的双保险）。 */
export const WORKSPACE_META_FILE = '.dsh-workspace.json'
