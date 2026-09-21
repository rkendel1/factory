import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.FACTORY_URL ?? '').replace(/\/$/, '');
const authorization = process.env.FACTORY_AUTHORIZATION;
const application = process.env.FACTORY_APPLICATION ?? 'software_factory';
const environment = process.env.FACTORY_ENVIRONMENT ?? 'production';

if (!baseUrl || !authorization) {
  console.error('FACTORY_URL and FACTORY_AUTHORIZATION are required');
  process.exit(1);
}

const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const variableName = `DEPLOY_SMOKE_${suffix}`;
const secretName = `DEPLOY_SECRET_${suffix}`;
const secretValue = randomUUID();
const query = new URLSearchParams({ application, environment }).toString();
const headers = { authorization, 'content-type': 'application/json' };
const configurationUrl = `${baseUrl}/v1/configuration`;

async function request(path, init = {}) {
  return fetch(`${configurationUrl}${path}${path.includes('?') ? '&' : '?'}${query}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
}

async function expect(response, status, operation) {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${operation} failed with HTTP ${response.status}`);
  if (text.includes(secretValue)) throw new Error(`${operation} exposed the secret value`);
  return text ? JSON.parse(text) : null;
}

const discovery = await fetch(`${baseUrl}/v1/ui`, { headers: { authorization } });
const discoveryText = await discovery.text();
if (!discovery.ok || !discoveryText.includes('AppPort/ui/1')) throw new Error('AppPort UI discovery failed');
if (discoveryText.includes(secretValue)) throw new Error('UI discovery exposed the secret value');

for (const route of ['/configuration', '/secrets', '/api-keys', '/notifications', '/webhooks', '/jobs']) {
  const surface = await fetch(`${baseUrl}${route}`, { headers: { authorization } });
  if (!surface.ok) throw new Error(`management surface ${route} failed with HTTP ${surface.status}`);
}

try {
  await expect(await request('/variables', {
    method: 'POST', body: JSON.stringify({ name: variableName, value: 'created', required: false }),
  }), 201, 'variable create');
  await expect(await request('/variables', {
    method: 'POST', body: JSON.stringify({ name: variableName, value: 'duplicate', required: false }),
  }), 400, 'duplicate variable rejection');
  let listed = await expect(await request(''), 200, 'configuration list after variable create');
  if (!listed.variables.some((item) => item.name === variableName && item.value === 'created')) throw new Error('created variable was not listed');
  const isolatedQuery = new URLSearchParams({ application: `${application}-isolated`, environment }).toString();
  const isolated = await expect(await fetch(`${configurationUrl}?${isolatedQuery}`, { headers }), 200, 'application scope isolation');
  if (isolated.variables.some((item) => item.name === variableName)) throw new Error('configuration crossed application scope');

  await expect(await request(`/variables/${variableName}`, {
    method: 'PATCH', body: JSON.stringify({ value: 'updated', required: false }),
  }), 200, 'variable update');
  listed = await expect(await request(''), 200, 'configuration list after variable update');
  if (!listed.variables.some((item) => item.name === variableName && item.value === 'updated')) throw new Error('updated variable was not listed');

  await expect(await request('/secrets', {
    method: 'POST', body: JSON.stringify({ name: secretName, value: secretValue, required: false }),
  }), 201, 'secret create');
  await expect(await request(`/secrets/${secretName}`, {
    method: 'PUT', body: JSON.stringify({ value: `${secretValue}-rotated`, required: false }),
  }), 200, 'secret rotate');
  listed = await expect(await request(''), 200, 'configuration list after secret rotate');
  const secret = listed.secrets.find((item) => item.name === secretName);
  if (!secret?.configured || 'value' in secret) throw new Error('secret metadata response is unsafe or incomplete');
} finally {
  await request(`/variables/${variableName}`, { method: 'DELETE' });
  await request(`/secrets/${secretName}`, { method: 'DELETE' });
}

const finalList = await expect(await request(''), 200, 'configuration list after cleanup');
if (finalList.variables.some((item) => item.name === variableName)
  || finalList.secrets.some((item) => item.name === secretName)) {
  throw new Error('production CRUD cleanup did not delete smoke-test records');
}

console.log('Production AppPort Services UI discovery and configuration CRUD passed');
