// Rebuild public schemas from the documented entity contract. No project data.
import fs from 'node:fs/promises';
import { VERSION } from '../src/paths.mjs';
const str = { type: 'string', minLength: 1 }, strings = { type: 'array', items: str, uniqueItems: true };
const refs = { type: 'array', items: { type: 'object', required: ['path'], properties: { path: str, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } };
const array = { type: 'array' };
const object = (required, properties) => ({ type: 'object', required, properties });
const entity = (prefix, properties, optional = []) => object(['id','createdAt','recordedBy','sourceRef',...Object.keys(properties).filter(k => !optional.includes(k))], { id: { type: 'string', pattern: `^${prefix}-[0-9]{4,}$` }, createdAt: str, recordedBy: str, sourceRef: str, ...properties });
const effects = object(['writes','network','paid'], { writes: { enum: ['none','test-artifacts','business-data'] }, network: { type: 'boolean' }, paid: { type: 'boolean' } });
const definitions = {
  requirement: entity('REQ', { intent: str, decision: { enum: ['proposed','needs_decision','accepted','rejected','superseded','withdrawn'] }, decisionRef: str, schedule: { enum: ['current','backlog','deferred'] }, featureIds: strings, openQuestions: array }, ['decisionRef']),
  feature: entity('FEAT', { title: str, user: str, scenario: str, goal: str, scope: array, exclusions: array, humanAutomation: { type: 'object' }, requirementIds: strings, dependencyIds: strings, entrypointIds: strings, implementationRefs: refs, acceptanceCriteria: strings, lifecycle: { enum: ['active','deprecated','retired'] }, deliveryStatus: { enum: ['planned','in_progress','implemented'] } }),
  acceptanceCriterion: entity('AC', { featureId: str, revision: { type: 'integer', minimum: 1 }, requirementIds: strings, preconditions: array, actions: { ...array, minItems: 1 }, expected: {}, verificationMethod: { enum: ['baseline','ui','api','cli','background'] }, effects, assertions: array, requiredEvidenceTypes: strings, dependencyRefs: array, implementationRefs: refs, requiredTargets: { type: 'array', minItems: 1, items: object(['targetId','entrypointId','roleRef','scenario','environmentRef','dataScopeRef'], Object.fromEntries(['targetId','entrypointId','roleRef','scenario','environmentRef','dataScopeRef'].map(k => [k,str]))) } }),
  change: entity('CHG', { requirementIds: strings, featureIds: strings, acIds: strings, baseRevision: { type: 'integer', minimum: 0 }, type: str, reason: str, decision: str, decisionRef: str, differences: array, impact: array, implementationRefs: refs, migrationImpact: str, recoveryImpact: str, lineageTransfers: array, status: { enum: ['open','implemented_pending_verification','closed','cancelled'] } }),
  evidence: { allOf: [{ $ref: 'acceptance.schema.json#/$defs/evidence' }, entity('EVD', {})] },
  iteration: entity('ITER', { goal: str, exclusions: array, snapshots: array, environmentRef: str, implementationBaseline: {} }),
};
const properties = { schemaVersion: { const: 1 }, projectId: str, sharedVersion: str, revision: { type: 'integer', minimum: 1 }, updatedAt: str, contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, previousRevisionHash: { type: ['string','null'] }, committedRequests: { type: 'array', items: object(['requestId','requestHash','committedRevision','assignedIds','result'], { requestId: str, requestHash: str, committedRevision: { type: 'integer', minimum: 1 }, assignedIds: strings, result: { type: 'object' } }) }, carryForward: array };
for (const [name, ref] of Object.entries({ requirements: 'requirement', features: 'feature', acceptanceCriteria: 'acceptanceCriterion', changes: 'change', evidence: 'evidence', iterations: 'iteration' })) properties[name] = { type: 'array', items: { $ref: `#/$defs/${ref}` } };
await fs.mkdir('schemas', { recursive: true });
await fs.writeFile('schemas/feature-map.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'feature-map.schema.json', ...object(Object.keys(properties), properties), $defs: definitions }, null, 2) + '\n');
const profile = JSON.parse(await fs.readFile('schemas/profile.schema.json', 'utf8'));
profile.properties.schemaVersion = { enum: [1,2] };
profile.properties.sharedVersion = { enum: [...new Set([...(profile.properties.sharedVersion?.enum || []), '0.1.0', '0.2.0', '0.2.1', VERSION])] };
profile.properties.featureMapRef = object(['schemaVersion','path','historyDir','evidenceDir'], { schemaVersion: { const: 1 }, path: str, historyDir: str, evidenceDir: str });
profile.properties.acceptanceRoutes = { type: 'array', items: { $ref: 'acceptance.schema.json#/$defs/route' } };
profile.properties.controls = { type: 'object' };
await fs.writeFile('schemas/profile.schema.json', JSON.stringify(profile, null, 2) + '\n');
