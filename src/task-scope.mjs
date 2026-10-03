// Shared deterministic UI signals; this does not interpret natural language.
export function taskScope(task = {}, profile = {}) {
  const kind = String(task.kind || '').toLowerCase();
  const workType = String(task.workType || '').toLowerCase();
  const shortPath = ['documentation','docs','writing','explanation','consultation','concept'].includes(workType)
    || ['documentation','docs','explanation','consultation','concept'].includes(kind);
  const ui = !shortPath && (task.ui === true || task.uiChange === true
    || ['ui','interface','interaction'].includes(kind)
    || (profile.entrypoints || []).some(item => item.id?.startsWith('ui-'))
    || (profile.acceptanceRoutes || []).some(route => route.kind === 'ui'));
  const resourceKind = ['ui','interface','interaction'].includes(kind) ? 'implementation' : kind;
  return {kind,resourceKind,workType,shortPath,ui};
}
