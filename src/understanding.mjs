import cases from '../policies/understanding-cases.json' with { type: 'json' };
import { queryRecords } from './records.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const stages = ['implemented', 'verified', 'published'];

function validField(value, type) {
  if (type === 'string') return nonempty(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'string-array') return Array.isArray(value) && value.every(nonempty);
  if (type === 'stage-claims') return object(value) && stages.every(stage => typeof value[stage] === 'boolean');
  if (type === 'stage-evidence') return Array.isArray(value) && value.every(entry => object(entry) && stages.includes(entry.stage) && nonempty(entry.sourceRef));
  if (type === 'choices') return Array.isArray(value) && value.every(choice => object(choice) && nonempty(choice.id) && typeof choice.critical === 'boolean' && ['pending', 'selected', 'withdrawn'].includes(choice.state));
  return false;
}

function semanticReviewBound(review, decisions) {
  return Boolean(object(review) && ['main-agent', 'jev'].includes(review.reviewer) && ['confirmed', 'rejected'].includes(review.status) &&
    nonempty(review.sourceRef) && Array.isArray(review.decisionIds) &&
    decisions.every(decision => review.decisionIds.includes(decision.id)));
}

function explicitViolations(caseId, proposal, decision) {
  const issues = [];
  const add = (code, field, detail) => issues.push({ code, field, detail, decisionId: decision.id, sourceRef: decision.sourceRef });
  switch (caseId) {
    case 'goal-preservation':
      if (proposal.optimizationTarget === 'few-components') add('goal-redirected', 'optimizationTarget', '把减少错误与返工改为减少组件，偏离已明确目标。');
      else if (proposal.optimizationTarget !== 'fewer-errors-and-rework') add('unclassified-goal', 'optimizationTarget', '新的目标类别需核原决定，不能自动判断用户已选择。');
      break;
    case 'required-regression':
      if (proposal.deletedRequiredChecks.length) add('necessary-regression-removed', 'deletedRequiredChecks', '必要回归被删除；不能以减少检查数量代替减少错误。');
      break;
    case 'complete-maintenance':
      if (!['all-applicable', 'sample', 'affected-only'].includes(proposal.maintenanceCoverage)) add('unclassified-coverage', 'maintenanceCoverage', '未知维护范围需核对适用入口。');
      else if (proposal.claimsCompleteMaintenance && proposal.maintenanceCoverage !== 'all-applicable') add('incomplete-maintenance-claim', 'maintenanceCoverage', '抽样或局部验证不支持完整维护声明。');
      break;
    case 'authorized-small-change':
      if (proposal.alreadyAuthorized && proposal.smallReversibleChange && !proposal.newDecisionRequired && proposal.asksForReapproval) add('redundant-confirmation', 'asksForReapproval', '已授权且无新关键取舍的小改重复要求批准。');
      break;
    case 'public-project-boundary':
      if (proposal.publicLayerContainsBusinessRules) add('public-business-mixing', 'publicLayerContainsBusinessRules', '项目业务规则被放入公共层。');
      break;
    case 'delivery-stages':
      for (const stage of stages) {
        if (proposal.claims[stage] && !proposal.stageEvidence.some(entry => entry.stage === stage)) add('unsupported-delivery-stage', `claims.${stage}`, '对应阶段没有证据引用，不能把计划、实现、验证或发布合并为完成。');
      }
      if (proposal.claims.published && (!proposal.claims.implemented || !proposal.claims.verified)) add('unsupported-delivery-stage', 'claims.published', '发布声明缺少实现或验证状态。');
      break;
    case 'undecided-product-choice':
      for (const choice of proposal.choices) {
        if (choice.state !== 'selected') continue;
        if (['silence', 'timeout', 'inferred'].includes(choice.approvalBasis) || choice.critical &&
          (choice.approvalBasis !== 'explicit-user-decision' || choice.decisionId !== decision.id)) {
          add('unknown-choice-inferred', `choices.${choice.id}`, '重要未决产品选择不能由沉默、超时或代理推定完成。');
        }
      }
      break;
  }
  return issues;
}

/** Checks structured declarations only. Free text meaning is reviewed by a person/agent or Jev. */
export function evaluateUnderstanding(input = {}) {
  if (!object(input)) input = {};
  const scenario = cases.cases.find(entry => entry.id === input.caseId);
  const decisions = Array.isArray(input.decisions) ? input.decisions : [];
  const base = {
    caseId: input.caseId ?? null, status: 'requires-review', issues: [],
    decisions: decisions.filter(object).map(decision => ({ key: decision.key, id: decision.id, sourceRef: decision.sourceRef })),
    structuralVerified: false, semanticVerified: false,
    semanticReviewRef: null,
    semanticsIndependentlyVerified: false,
    limitation: '程序仅核结构和显式违反项，不理解自由文本。语义审查需核原用户决定与方案；通过不代表实现、真实验收或发布完成。',
  };
  if (!scenario) return { ...base, issues: [{ code: 'unknown-case', field: 'caseId', detail: '类别外任务交主代理核目标，不能从代表性案例推断新产品决定。' }] };
  const decision = decisions.find(entry => object(entry) && entry.key === scenario.decisionKey &&
    nonempty(entry.id) && nonempty(entry.sourceRef) && entry.status === 'active' && ['decision', 'preference'].includes(entry.kind));
  if (!decision) return { ...base, issues: [{ code: 'missing-active-decision', field: 'decisions', detail: '缺少已明确且当前有效的用户决定引用。' }] };
  if (!object(input.proposal)) return { ...base, issues: [{ code: 'invalid-proposal', field: 'proposal', detail: '方案需要结构化声明，原文另由语义审查核对。' }] };
  const invalid = Object.entries(scenario.fields).filter(([field, type]) => !validField(input.proposal[field], type));
  if (invalid.length) return { ...base, issues: invalid.map(([field]) => ({ code: 'missing-or-invalid-fact', field, detail: '缺少有效结构事实，不能用默认值补成用户选择。' })) };
  const issues = explicitViolations(scenario.id, input.proposal, decision);
  const reviewBound = semanticReviewBound(input.semanticReview, [decision]);
  const semanticVerified = reviewBound && input.semanticReview.status === 'confirmed';
  if (reviewBound && input.semanticReview.status === 'rejected') issues.push({ code: 'semantic-conflict', field: 'semanticReview', detail: '已绑定原决定的语义审查拒绝当前方案，结构声明不能覆盖该结果。', decisionId: decision.id, sourceRef: input.semanticReview.sourceRef });
  const unclassified = issues.some(issue => issue.code.startsWith('unclassified-'));
  return {
    ...base, issues, structuralVerified: true, semanticVerified,
    semanticReviewRef: reviewBound ? input.semanticReview.sourceRef : null,
    status: unclassified ? 'requires-review' : issues.length ? 'rejected' : semanticVerified ? 'accepted' : 'semantic-review-required',
    semanticReviewer: reviewBound ? input.semanticReview.reviewer : null,
    semanticReviewProvenance: reviewBound ? 'supplied-review-reference' : null,
    representativeSourceRef: scenario.sourceRef,
  };
}

/** Reuse the existing scoped record index. No decision body is written here. */
export async function checkUnderstanding(input = {}) {
  if (!object(input) || !nonempty(input.stateRoot)) throw new TypeError('checkUnderstanding requires stateRoot');
  const bindings = object(input.decisionBindings) ? input.decisionBindings : {};
  const decisions = [];
  for (const [key, binding] of Object.entries(bindings)) {
    const id = typeof binding === 'string' ? binding : binding?.id;
    const query = typeof binding?.query === 'string' ? binding.query : '';
    if (!nonempty(key) || !nonempty(id)) continue;
    // queryRecords intentionally caps results. Matching the exact ID prevents a
    // similarly worded record from being substituted when the desired ID is absent.
    const records = await queryRecords(input.stateRoot, { scope: input.scope ?? 'global', query, ids: [id], limit: 8 });
    const record = records.find(entry => entry.id === id);
    if (record) decisions.push({ ...record, key, status: 'active' });
  }
  return evaluateUnderstanding({ ...input, decisions });
}
