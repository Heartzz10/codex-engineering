import { taskScope } from './task-scope.mjs';
// A diagnostic summary of registration gaps. It never asserts that a check or
// business scenario has passed.
export function startupReadiness(profile, task = {}) {
  const scope = taskScope(task, profile);
  const documentOnly = scope.shortPath;
  const uiTask = scope.ui;
  const gaps = [];
  const add = (id, message, action) => gaps.push({ id, message, action });
  if (!profile.authoritativeDocuments?.length || profile.missingAuthoritativeDocuments?.length)
    add('documents', '缺少权威项目材料或登记文件不存在', '检查 profile.authoritativeDocuments 中的文件路径与项目原件');
  if (profile.missingFeatureMapDocument)
    add('feature_map_document', '登记的功能地图文档不存在', '恢复原文档或修正 featureMapDocument 路径');
  if (!documentOnly) {
    if (!profile.entrypoints?.length) add('entrypoints', '未登记本次实际入口', '在 profile.entrypoints 登记真实入口及角色/环境，现场核对');
    if (!profile.checks?.length) add('checks', '没有已登记程序检查', '登记受影响的现有检查；不把空检查集视为通过');
    if (profile.featureMapStatus === 'needs_feature_map') add('feature_map', '缺少功能与验收条件来源', '绑定现有功能地图或文档；待决业务条件保持待决');
    if (!profile.controls?.sourceReview?.inputs?.length && !profile.sourceScopes?.length)
      add('source_scope', '未声明源码检查范围', '在 controls.sourceReview.inputs 声明本次相关源码');
    if (!profile.acceptanceRoutes?.length) add('acceptance', '没有真实验收路径', '登记可操作入口、证据保存方式与业务读回');
    else if (profile.acceptanceRoutes.some(route => !route.driverRef || route.available === false))
      add('acceptance_driver', '部分验收路径缺可用驱动或证据入口', '检查 acceptanceRoutes 的 driverRef、available 与原件保存能力');
    if (uiTask && profile.uiQualityStatus !== 'configured') add('ui_quality', 'UI 质量规则未配置', '复用 UI prepare 配置适用规则；不适用项记录理由');
  }
  return { status: gaps.length ? 'needs_setup' : 'registered_for_checks', taskScope: documentOnly ? 'documentation' : uiTask ? 'ui' : 'engineering', gaps,
    action: gaps.length ? '补齐适用缺项后再运行检查与真实验收' : '继续运行程序检查、整体 UI 审查（如适用）及真实业务验收；此处不表示通过' };
}
