const baseUrl = (process.env.FACTORY_URL ?? '').replace(/\/$/, '');
const authorization = process.env.FACTORY_AUTHORIZATION;
const body = process.env.FACTORY_RUN_BODY;

if (!baseUrl || !authorization || !body) {
  console.error('FACTORY_URL, FACTORY_AUTHORIZATION, and FACTORY_RUN_BODY are required');
  process.exit(1);
}

const health = await fetch(`${baseUrl}/health`);
if (!health.ok) {
  throw new Error(`health failed with HTTP ${health.status}`);
}
const headers = { authorization, 'content-type': 'application/json' };
const unauthorized = await fetch(`${baseUrl}/v1/runs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
if (unauthorized.status !== 401) {
  throw new Error(`unauthorized request was not rejected: HTTP ${unauthorized.status}`);
}
const created = await fetch(`${baseUrl}/v1/runs`, {
  method: 'POST',
  headers,
  body,
});
if (created.status !== 201) {
  throw new Error(`run creation failed with HTTP ${created.status}`);
}
const run = await created.json();
const retrieved = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(run.id)}`, { headers });
if (!retrieved.ok) {
  throw new Error(`run retrieval failed with HTTP ${retrieved.status}`);
}
const evidence = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(run.id)}/evidence`, { headers });
if (![200, 404].includes(evidence.status)) {
  throw new Error(`evidence retrieval failed with HTTP ${evidence.status}`);
}
console.log(`Factory smoke test passed for run ${run.id}`);
