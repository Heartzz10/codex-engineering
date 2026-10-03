// Historical fixtures keep their labels; newly prepared contracts use native binary labels.
export function fixtureResponse(request, choice = 'yes', inputTokens = 1000) {
  return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(request.body.questions).map(([id, q]) => {
    const native = Object.hasOwn(q.criteria, 'yes') ? ({ supported: 'yes', unsupported: 'no', insufficient: 'unknown', no_match: 'no' }[choice] ?? choice) : choice;
    return [id, { type: 'choice', choice: native, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === native ? 1 : 0])), confidence: 1 }];
  })), usage: { input_tokens: inputTokens, output_tokens: 0 } };
}
