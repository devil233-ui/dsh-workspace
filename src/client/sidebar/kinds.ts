/*
 * @Description: 本插件在宿主右侧栏注册的标签类型（kind）常量 —— 注册方（register.tsx）与打开方（open-in-sidebar.tsx）共用
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/kinds.ts
 */

/** 文件查看器（认领 dsh-resource://file/ 地址）。 */
export const FILE_ID = 'dsh-workspace:remote-file'
/** 文件管理（文件树）。 */
export const FILES_ID = 'dsh-workspace:remote-files'
export const SSH_ID = 'dsh-workspace:ssh'
export const GIT_ID = 'dsh-workspace:git'
/**
 * 任务页（方案 3.7：tasks/TasksTab.tsx）/ 侧边对话（方案 3.8：sidechat/SidechatTab.tsx；同时是资源协议名，见 sidechat/address.ts）。
 * dshWorkspace.openTab('tasks' | 'sidechat') 按这两个常量打开。
 */
export const TASKS_KIND = 'dshws-tasks'
export const SIDECHAT_KIND = 'dshws-sidechat'
/** 宿主内置浏览器标签（dsh-client-ui-sidebar-browser 的 BROWSER_KIND）。 */
export const BROWSER_KIND = 'browser'
