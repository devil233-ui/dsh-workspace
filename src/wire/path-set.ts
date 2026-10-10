/*
 * @Description: 路径集合的小工具（宿主打包与浏览器批量删除共用）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/wire/path-set.ts
 *
 * 本文件会进浏览器 bundle：不得 import 任何 node: 模块。
 */

/**
 * 只保留最外层路径：a 与 a/b 同时选中时去掉 a/b（同一文件不重复打包 / 删除）。
 * 比较时统一正斜杠、去结尾斜杠并去重；保持原有顺序。
 */
export function outermost(paths: readonly string[]): string[] {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, '/')
    return s.length > 1 ? s.replace(/\/+$/, '') : s
  }
  const list = [...new Set(paths.map(norm))]
  return list.filter((p) => !list.some((q) => q !== p && (q === '/' ? p.startsWith('/') : p.startsWith(`${q}/`))))
}
