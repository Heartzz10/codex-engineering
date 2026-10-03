import { hash, invariant, plain, text } from '../skills/review-product-plan/scripts/jev-client.mjs';

export const COMBINATION_VERSION = 'binary-all-required-v1';
export function binaryQuestions(judgment, policy, sources = [], { standardSha = hash(policy), combinationRule } = {}) {
  const definitions = judgment.propositions ?? (judgment.kind === 'method_selection'
    ? (judgment.candidates ?? []).map(c => ({ id: c.id, proposition: `方法“${c.description}”是否满足当前任务的指定适用条件？`, candidate_id: c.id }))
    : policy.atomic_checks[judgment.kind]);
  invariant(Array.isArray(definitions) && definitions.length > 0 && definitions.length <= 16, '缺少单命题或题目数量超限');
  const seen = new Set();
  const contracts = definitions.map(d => {
    invariant(plain(d) && /^[a-z][a-z0-9_]{0,63}$/.test(d.id) && !seen.has(d.id) && text(d.proposition), '单命题ID/陈述无效或重复'); seen.add(d.id);
    if (judgment.kind === 'method_selection') invariant((judgment.candidates ?? []).some(c => c.id === d.candidate_id), '方法原子题须绑定已提供candidate_id');
    return { question_id: `${judgment.id}__${d.id}`, parent_id: judgment.id, object: judgment.target,
      proposition: d.proposition, sources, standard_version: policy.version, standard_sha256: standardSha,
      yes_boundary: d.yes_boundary ?? policy.criteria.yes, no_boundary: d.no_boundary ?? policy.criteria.no,
      unknown_condition: d.unknown_condition ?? policy.criteria.unknown,
      applicability: { source: '指定任务、判断对象及绑定原件', rule: '仅判断该对象的指定命题；适用前提不清为unknown，不能伪造yes' },
      combination_rule: combinationRule ?? (judgment.kind === 'method_selection' ? 'independent_candidates_v1' : COMBINATION_VERSION),
      ...(d.candidate_id ? { candidate_id: d.candidate_id } : {}) };
  });
  if (judgment.kind === 'method_selection') invariant(judgment.candidates.every(c => contracts.some(q => q.candidate_id === c.id)), '每个候选均须有适用题，不能静默漏选');
  return { contracts, questions: Object.fromEntries(contracts.map(c => [c.question_id, { type: 'choice',
    instructions: `${policy.common_instructions}\n实际判断对象：${judgment.target}\n唯一命题：${c.proposition}\nyes边界：${c.yes_boundary}\nno边界：${c.no_boundary}\nunknown条件：${c.unknown_condition}`,
    criteria: policy.criteria }])) };
}

/** Preserve native choices; incomplete, conflicting or low-confidence facts never authorize reuse. */
export function combineBinaryAnswers(request, answers) {
  const contracts = request.question_contracts ?? [];
  const byId = new Map(); const reasons = [];
  for (const a of answers) {
    const id = a.question_id ?? a.criterion_id;
    if (byId.has(id)) reasons.push('answer_conflict');
    byId.set(id, a);
  }
  const facts = contracts.map(c => {
    const a = byId.get(c.question_id);
    const reason = !a ? 'missing_answer' : !['yes', 'no', 'unknown'].includes(a.provider_choice) ? 'invalid_answer'
      : a.confidence < .8 ? 'model_uncertain' : a.provider_choice === 'unknown' ? 'model_unknown' : null;
    if (reason) reasons.push(reason);
    return { question_id: c.question_id, parent_id: c.parent_id, candidate_id: c.candidate_id,
      choice: reason ? 'unknown' : a.provider_choice, reason };
  });
  if (!contracts.length || byId.size !== contracts.length) reasons.push('question_set_mismatch');
  const conflict = reasons.includes('answer_conflict') || reasons.includes('question_set_mismatch');
  if (request.kind === 'method_selection') {
    const candidates = [...new Set(contracts.map(c => c.candidate_id))].map(id => {
      const subset = facts.filter(f => f.candidate_id === id);
      return { candidate_id: id, choice: subset.some(f => f.choice === 'no') ? 'no' : subset.some(f => f.choice === 'unknown') ? 'unknown' : 'yes' };
    });
    const matches = candidates.filter(f => f.choice === 'yes').map(f => f.candidate_id);
    const unknown = conflict || candidates.some(f => f.choice === 'unknown');
    return { version: 'independent_candidates_v1', choice: unknown ? 'unknown' : matches.length ? 'yes' : 'no',
      status: unknown ? 'unknown' : matches.length > 1 ? 'multi_match' : matches.length === 1 ? 'match' : 'no_match', matches, candidates, facts, reason_codes: [...new Set(reasons)] };
  }
  const choice = conflict ? 'unknown' : facts.some(f => f.choice === 'no') ? 'no' : facts.some(f => f.choice === 'unknown') ? 'unknown' : 'yes';
  return { version: COMBINATION_VERSION, choice, status: choice, facts, reason_codes: [...new Set(reasons)] };
}

export function legacyAnswerById(request, answers) {
  return answers.find(a => (a.question_id ?? a.criterion_id) === request.judgment_id);
}
