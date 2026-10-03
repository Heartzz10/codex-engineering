import path from 'node:path';
import { PACKAGE_ROOT, json, existingInside, assert, VERSION } from './paths.mjs';
import { taskScope } from './task-scope.mjs';

export async function selectResources(task, profile = {}) {
  const catalog = await json(path.join(PACKAGE_ROOT, 'catalog/index.json'));
  assert(catalog.version === VERSION && Array.isArray(catalog.resources), 'Catalog version or structure mismatch');
  const ids = new Set(), selected = [];
  const scope = taskScope(task, profile);
  for (const item of catalog.resources) {
    assert(typeof item.id === 'string' && !ids.has(item.id), 'Duplicate or missing resource ID'); ids.add(item.id);
    assert(item.version === VERSION && Array.isArray(item.taskKinds), 'Invalid resource version or task types');
    await existingInside(PACKAGE_ROOT, item.path);
    if (item.taskKinds.includes(scope.resourceKind) && (!item.requiresUiChange || scope.ui)) selected.push({id:item.id,kind:item.kind,path:item.path,version:item.version});
  }
  return selected;
}
