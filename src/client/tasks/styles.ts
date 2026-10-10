/*
 * @Description: 任务页样式（由 styles.ts 的 injectStyles 一并注入）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/styles.ts
 *
 * 全部取宿主 --dsw- 主题变量，随明暗主题切换；类名统一 dshws-tasks / dshws-job / dshws-sub / dshws-dag / dshws-wf / dshws-team 前缀。
 */
export const TASKS_CSS = `
.dshws-tasks { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshws-tasks-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 16px; }
.dshws-tasks-section { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshws-tasks-section-head { display: flex; align-items: center; gap: 8px; padding: 4px 10px 4px 4px; min-height: 30px; }
.dshws-tasks-section-toggle {
  flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 6px; border: 0; background: transparent;
  padding: 4px 6px; border-radius: 6px; cursor: pointer; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-align: left;
}
.dshws-tasks-section-toggle:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-tasks-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
  border-radius: 9px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 500;
}
.dshws-tasks-list { display: flex; flex-direction: column; padding: 0 6px 8px; gap: 2px; }
.dshws-tasks-empty { padding: 6px 16px 12px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dshws-tasks-note { margin: 4px 10px; padding: 6px 8px; border-radius: 6px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); white-space: pre-wrap; }
.dshws-tasks-note[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dshws-tasks-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dshws-tasks-sub { padding: 8px 8px 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dshws-tasks-more { align-self: flex-start; margin: 4px 8px; font-size: 12px; }
.dshws-tasks-btn {
  border: 1px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary);
  border-radius: 6px; padding: 2px 10px; font-size: 12px; line-height: 20px; cursor: pointer; white-space: nowrap;
}
.dshws-tasks-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-tasks-btn:disabled { opacity: .5; cursor: default; }
.dshws-tasks-btn[data-danger="true"] { color: var(--dsw-alias-state-error-primary); }
.dshws-tasks-btn[data-danger="true"][data-armed="true"] { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); color: #fff; }
.dshws-tasks-btn[data-primary="true"] { background: var(--dsw-alias-brand-primary, #3b82f6); border-color: transparent; color: var(--dsw-alias-brand-primary-invert, #fff); }
.dshws-tasks-input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l3); border-radius: 6px; padding: 4px 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; resize: vertical;
}

/* 状态点：运行中带呼吸动画 */
.dshws-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #9ca3af); }
.dshws-dot[data-state="running"] { background: #3b82f6; animation: dshws-pulse 1.4s ease-in-out infinite; }
.dshws-dot[data-state="stopping"], .dshws-dot[data-state="provisioning"] { background: #d08a00; }
.dshws-dot[data-state="completed"] { background: #16a34a; }
.dshws-dot[data-state="failed"], .dshws-dot[data-state="killed"] { background: #e5484d; }
.dshws-dot[data-state="cancelled"] { background: #d08a00; }
@keyframes dshws-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .dshws-dot[data-state="running"] { animation: none; } }

.dshws-pill {
  flex: 0 0 auto; padding: 0 6px; border-radius: 4px; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
}
.dshws-pill[data-state="running"] { color: #3b82f6; }
.dshws-pill[data-state="completed"] { color: #16a34a; }
.dshws-pill[data-state="failed"] { color: #e5484d; }
.dshws-pill[data-state="cancelled"] { color: #d08a00; }

/* 后台任务 */
.dshws-job { border-radius: 8px; }
.dshws-job[data-open="true"] { background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.dshws-job-head {
  width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; cursor: pointer;
  padding: 6px 8px 2px; border-radius: 8px; color: inherit; font: inherit; text-align: left; min-width: 0;
}
.dshws-job-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-job-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dshws-job-meta { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
.dshws-job-time, .dshws-job-progress { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.dshws-job-sub { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 0 8px 6px 24px; font-size: 11px; color: var(--dsw-alias-label-tertiary); min-width: 0; }
.dshws-job-sub > [data-tone="warn"], .dshws-job-detail[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dshws-job-owner { max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-job-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dshws-job-body { padding: 0 8px 8px; }
.dshws-job-output {
  margin: 0; max-height: 260px; min-height: 48px; overflow: auto; padding: 8px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l2);
  font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all;
  color: var(--dsw-alias-label-primary); overscroll-behavior: contain;
}
.dshws-job-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 6px; }
.dshws-job-streaming { font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* 子代理：树视图 */
.dshws-sub-row { position: relative; display: flex; flex-wrap: wrap; align-items: center; border-radius: 8px; padding-right: 4px; }
.dshws-sub-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-sub-row[data-current="true"] { background: rgba(59,130,246,.1); }
.dshws-sub-main {
  flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; border: 0; background: transparent;
  padding: 6px 4px; cursor: pointer; color: inherit; font: inherit; text-align: left;
}
.dshws-sub-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-sub-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dshws-sub-jump { flex: 0 0 auto; width: 24px; height: 24px; font-size: 13px; }
.dshws-sub-line {
  flex: 1 0 100%; box-sizing: border-box; padding: 0 8px 6px 18px; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-tertiary);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
}
.dshws-sub-line[data-running="true"] { color: var(--dsw-alias-label-secondary); }

/* 子代理：拓扑图 */
.dshws-dag-wrap { overflow: auto; padding: 0 6px 8px; max-height: 480px; overscroll-behavior: contain; }
.dshws-dag { display: block; }
.dshws-dag-edge { fill: none; stroke: var(--dsw-alias-border-l3, #c4c4c4); stroke-width: 1.4; }
.dshws-dag-node { cursor: pointer; outline: none; }
.dshws-dag-node rect { fill: var(--dsw-alias-bg-layer-1, #fff); stroke: var(--dsw-alias-border-l3, #c4c4c4); stroke-width: 1; }
.dshws-dag-node:hover rect, .dshws-dag-node:focus-visible rect { stroke: #3b82f6; }
.dshws-dag-node[data-current="true"] rect { stroke: #3b82f6; stroke-width: 1.6; }
.dshws-dag-node[data-root="true"] rect { fill: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.dshws-dag-dot { fill: var(--dsw-alias-label-tertiary, #9ca3af); }
.dshws-dag-node[data-running="true"] .dshws-dag-dot { fill: #3b82f6; animation: dshws-pulse 1.4s ease-in-out infinite; }
.dshws-dag-title { font-size: 12px; font-weight: 500; fill: var(--dsw-alias-label-primary); }
.dshws-dag-line { font-size: 10.5px; fill: var(--dsw-alias-label-tertiary); }

/* 工作流 */
.dshws-wf { padding: 6px 8px; border-radius: 8px; }
.dshws-wf + .dshws-wf { border-top: 1px dashed var(--dsw-alias-border-l2); }
.dshws-wf-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dshws-wf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dshws-wf-phase { padding: 4px 0 0 14px; }
.dshws-wf-phase-title { font-size: 11px; color: var(--dsw-alias-label-tertiary); padding: 2px 0; }
.dshws-wf-members { display: flex; flex-wrap: wrap; gap: 4px; }
.dshws-wf-member {
  display: inline-flex; align-items: center; gap: 5px; max-width: 100%; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
  background: transparent; padding: 1px 8px; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dshws-wf-member > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshws-wf-member:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshws-wf-member .dshws-dot { width: 6px; height: 6px; }

/* 团队看板 */
.dshws-team { padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
.dshws-team-members { display: flex; flex-wrap: wrap; gap: 6px; }
.dshws-team-member { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 2px 8px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }
.dshws-team-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.dshws-team-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshws-team-col-title { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshws-team-task { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px 8px; background: var(--dsw-alias-bg-layer-1); }
.dshws-team-task[data-ready="true"] { border-left: 3px solid #16a34a; }
.dshws-team-task .dshws-job-sub { padding: 2px 0 0; }
.dshws-team-task-subject { font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.dshws-team-actions { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 6px; }
.dshws-team-form { display: flex; flex-direction: column; gap: 6px; }
.dshws-team-form > button { align-self: flex-end; }

/* 窄屏（≤640px，与 narrow.ts 的 NARROW_MAX_WIDTH 一致）：看板单列、拓扑图限高 */
@media (max-width: 640px) {
  .dshws-team-board { grid-template-columns: 1fr; }
  .dshws-dag-wrap { max-height: 360px; }
  .dshws-job-output { max-height: 200px; }
}
`
