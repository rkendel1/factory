/**
 * The Factory product surface.
 *
 * Factory is an Actions Orchestrator. AppPort Services remains reachable as the
 * infrastructure and configuration area, but it is no longer where a new user
 * lands: the landing page has to answer what exists, what Factory wants to
 * change, what is running, what needs a human, what happened, and on whose
 * authority — without the reader opening a configuration screen to find out.
 */

export const PRODUCT_NAV = [
  { id: 'overview', label: 'Overview', href: '/factory' },
  { id: 'projects', label: 'Projects', href: '/factory/projects' },
  { id: 'actions', label: 'Actions', href: '/factory/actions' },
  { id: 'runs', label: 'Runs', href: '/factory/runs' },
  { id: 'providers', label: 'Providers', href: '/factory/providers' },
  { id: 'services', label: 'AppPort Services', href: '/services' },
  { id: 'settings', label: 'Settings', href: '/factory/settings' },
] as const;

export type ProductSurfaceId = typeof PRODUCT_NAV[number]['id'];

const STYLES = `
:root{color-scheme:light dark;--bg:#fff;--fg:#172033;--muted:#667085;--line:#e4e7ec;--accent:#175cd3;--ok:#067647;--warn:#b54708;--bad:#b42318;--panel:#f9fafb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1419;--fg:#e6e8eb;--muted:#98a2b3;--line:#272d36;--accent:#84aaf0;--panel:#161b22}}
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
a{color:var(--accent)}
header{border-bottom:1px solid var(--line);padding:1rem 1.25rem}
header .brand{font-weight:700;letter-spacing:-.01em}
header .tag{color:var(--muted);font-size:.85rem;margin-left:.5rem}
nav{display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.75rem}
nav a{padding:.35rem .7rem;border-radius:999px;text-decoration:none;color:var(--muted);font-size:.9rem}
nav a[aria-current="page"]{background:var(--accent);color:#fff}
main{max-width:1080px;margin:0 auto;padding:1.5rem 1.25rem 4rem}
h1{font-size:1.5rem;margin:.2rem 0 .1rem}
h2{font-size:1.05rem;margin:2rem 0 .6rem}
.lede{color:var(--muted);margin:0 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem}
.card{border:1px solid var(--line);border-radius:10px;padding:.9rem;background:var(--panel)}
.card h3{margin:0 0 .35rem;font-size:1rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.55rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.03em}
.muted{color:var(--muted)}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.78rem;border:1px solid var(--line)}
.pill.ok{color:var(--ok);border-color:currentColor}
.pill.warn{color:var(--warn);border-color:currentColor}
.pill.bad{color:var(--bad);border-color:currentColor}
ol.plan{padding-left:1.1rem;margin:.3rem 0}
ol.plan li{margin:.3rem 0}
ol.plan .basis{color:var(--muted);font-size:.82rem}
.phases{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.5rem;margin:.5rem 0}
.phase{border:1px solid var(--line);border-radius:8px;padding:.6rem;background:var(--panel)}
.phase .name{font-size:.78rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
details{border:1px solid var(--line);border-radius:8px;padding:.6rem;margin-top:.75rem}
summary{cursor:pointer;color:var(--muted)}
pre{overflow:auto;font-size:.82rem;background:var(--panel);padding:.6rem;border-radius:6px}
form{display:flex;gap:.5rem;flex-wrap:wrap;margin:.75rem 0}
input,select,button,textarea{font:inherit;padding:.45rem .6rem;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}
.empty{border:1px dashed var(--line);border-radius:10px;padding:1.25rem;color:var(--muted);text-align:center}
@media (max-width:640px){main{padding:1rem}table{font-size:.86rem}}
`;

function nav(active: ProductSurfaceId): string {
  return `<nav>${PRODUCT_NAV.map((item) =>
    `<a href="${item.href}"${item.id === active ? ' aria-current="page"' : ''}>${item.label}</a>`).join('')}</nav>`;
}

export function productPage(active: ProductSurfaceId, title: string, content: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Factory · ${escapeHtml(title)}</title><style>${STYLES}</style></head><body>`
    + `<header><span class="brand">Factory</span><span class="tag">Actions Orchestrator</span>${nav(active)}</header>`
    + `<main>${content}</main>`
    + `<script type="module">${CLIENT}${script}</script></body></html>`;
}

/**
 * Embed a value inside a `<script>` block.
 *
 * `JSON.stringify` alone is not enough here: it leaves `<` intact, so an
 * identifier taken from the URL path could close the script element and run as
 * markup. Escaping the characters that can end the element keeps the value a
 * value.
 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

/**
 * The surface reads the same authenticated API a script would. It holds no
 * state of its own, so a reload reconstructs the view from FeltDB rather than
 * from anything the page remembered.
 */
const CLIENT = `
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || ('Request failed with HTTP ' + response.status));
  return body;
}
export function statusPill(status) {
  const tone = ['succeeded','completed','associated','passed','ready'].includes(status) ? 'ok'
    : ['failed','unassociated','unverified'].includes(status) ? 'bad'
    : ['awaiting-approval','requires-connection','requires-executable'].includes(status) ? 'warn' : '';
  return '<span class="pill ' + tone + '">' + esc(status) + '</span>';
}
export function fail(node, error) {
  node.innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
}
window.factory = { api, esc, statusPill, fail };
`;

export function overviewPage(): string {
  return productPage('overview', 'Overview', `
<h1>Overview</h1>
<p class="lede">What Factory is keeping true, what it is changing, and on whose authority.</p>
<section><h2>Authority</h2><div id="authority"><p class="muted">Loading…</p></div></section>
<section><h2>Projects</h2><div id="projects"><p class="muted">Loading…</p></div></section>
<section><h2>Active Actions</h2><div id="active"><p class="muted">Loading…</p></div></section>
<section><h2>Needs attention</h2><div id="attention"><p class="muted">Loading…</p></div></section>
<section><h2>Recent activity</h2><div id="activity"><p class="muted">Loading…</p></div></section>
`, `
const { api, esc, statusPill, fail } = window.factory;
try {
  const data = await api('/v1/overview');
  const authority = data.authority;
  document.querySelector('#authority').innerHTML =
    '<div class="card"><h3>' + esc(authority.application) + ' ' + statusPill(authority.state) + '</h3>'
    + '<p class="muted">' + (authority.principals || []).map(esc).join(', ') + '</p>'
    + '<p class="muted">' + esc(authority.reason || (authority.resource + ' in tenant ' + authority.tenant)) + '</p></div>';

  document.querySelector('#projects').innerHTML = data.projects.length
    ? '<div class="grid">' + data.projects.map((project) =>
        '<div class="card"><h3><a href="/factory/projects/' + esc(project.id) + '">' + esc(project.name) + '</a></h3>'
        + '<p class="muted">' + (project.environments.length
            ? project.environments.map((environment) => esc(environment.name)).join(' · ')
            : 'no environments yet') + '</p>'
        + '<p>' + project.activeActions + ' active · ' + project.attentionRequired + ' need attention</p></div>').join('')
      + '</div>'
    : '<div class="empty">No projects yet. Create one on the Projects page.</div>';

  document.querySelector('#active').innerHTML = data.activeActions.length
    ? '<table><thead><tr><th>Action</th><th>Project</th><th>Environment</th><th>Status</th><th>Started</th></tr></thead><tbody>'
      + data.activeActions.map((action) =>
        '<tr><td><a href="/factory/actions/' + esc(action.id) + '">' + esc(action.type) + '</a><div class="muted">' + esc(action.intent) + '</div></td>'
        + '<td>' + esc(action.projectId) + '</td><td>' + esc(action.environmentId || '—') + '</td>'
        + '<td>' + statusPill(action.status) + '</td><td class="muted">' + esc(action.startedAt) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">Nothing is running.</div>';

  document.querySelector('#attention').innerHTML = data.attentionRequired.length
    ? '<table><thead><tr><th>Action</th><th>Project</th><th>Status</th></tr></thead><tbody>'
      + data.attentionRequired.map((action) =>
        '<tr><td><a href="/factory/actions/' + esc(action.id) + '">' + esc(action.intent) + '</a></td>'
        + '<td>' + esc(action.projectId) + '</td><td>' + statusPill(action.status) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">Nothing needs a human right now.</div>';

  document.querySelector('#activity').innerHTML = data.recentActivity.length
    ? '<table><thead><tr><th>Run</th><th>Operation</th><th>Status</th><th>Evidence</th></tr></thead><tbody>'
      + data.recentActivity.map((run) =>
        '<tr><td><a href="/factory/runs/' + esc(run.id) + '">' + esc(run.id) + '</a></td>'
        + '<td>' + esc(run.operation) + '</td><td>' + statusPill(run.status) + '</td>'
        + '<td class="muted">' + esc(run.evidenceId || '—') + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">No runs yet.</div>';
} catch (error) { fail(document.querySelector('#projects'), error); }
`);
}

export function projectsPage(): string {
  return productPage('projects', 'Projects', `
<h1>Projects</h1>
<p class="lede">A project groups the repositories, environments, and desired state Factory keeps true.</p>
<form id="create"><input name="name" placeholder="Project name" required><input name="description" placeholder="Description"><button>Create project</button></form>
<p id="status" class="muted"></p>
<div id="projects"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#projects');
async function load() {
  try {
    const { projects } = await api('/v1/projects');
    target.innerHTML = projects.length
      ? '<table><thead><tr><th>Project</th><th>Status</th><th>Created</th></tr></thead><tbody>'
        + projects.map((project) =>
          '<tr><td><a href="/factory/projects/' + esc(project.id) + '">' + esc(project.name) + '</a>'
          + '<div class="muted">' + esc(project.description || '') + '</div></td>'
          + '<td>' + statusPill(project.status) + '</td>'
          + '<td class="muted">' + esc(project.createdAt) + '</td></tr>').join('')
        + '</tbody></table>'
      : '<div class="empty">No projects yet.</div>';
  } catch (error) { fail(target, error); }
}
document.querySelector('#create').onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await api('/v1/projects', { method: 'POST', body: JSON.stringify(data) });
    event.target.reset();
    document.querySelector('#status').textContent = 'Project created';
    await load();
  } catch (error) { document.querySelector('#status').textContent = error.message; }
};
await load();
`);
}

export function projectPage(projectId: string): string {
  return productPage('projects', 'Project', `
<h1 id="name">Project</h1>
<p class="lede" id="description"></p>
<nav id="tabs"></nav>
<div id="panel"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const projectId = ${scriptLiteral(projectId)};
const panel = document.querySelector('#panel');
const TABS = ['Overview','Repositories','Environments','Desired State','Actions','Runs'];
let current = location.hash.replace('#','') || 'Overview';

document.querySelector('#tabs').innerHTML = TABS.map((tab) =>
  '<a href="#' + tab + '" data-tab="' + tab + '">' + tab + '</a>').join('');

function markTabs() {
  document.querySelectorAll('#tabs a').forEach((link) =>
    link.toggleAttribute('aria-current', link.dataset.tab === current));
}

async function render() {
  markTabs();
  panel.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (current === 'Overview') {
      const [project, repositories, environments, actions, runs] = await Promise.all([
        api('/v1/projects/' + projectId),
        api('/v1/projects/' + projectId + '/repositories'),
        api('/v1/projects/' + projectId + '/environments'),
        api('/v1/projects/' + projectId + '/actions'),
        api('/v1/projects/' + projectId + '/runs'),
      ]);
      document.querySelector('#name').textContent = project.name;
      document.querySelector('#description').textContent = project.description || '';
      panel.innerHTML = '<div class="grid">'
        + '<div class="card"><h3>Repositories</h3><p>' + repositories.repositories.length + '</p></div>'
        + '<div class="card"><h3>Environments</h3><p>' + environments.environments.map((e) => esc(e.name)).join(', ') + '</p></div>'
        + '<div class="card"><h3>Active Actions</h3><p>' + actions.actions.filter((a) => a.status === 'running' || a.status === 'authorized').length + '</p></div>'
        + '<div class="card"><h3>Recent Runs</h3><p>' + runs.runs.length + '</p></div></div>';
    } else if (current === 'Repositories') {
      const { repositories } = await api('/v1/projects/' + projectId + '/repositories');
      panel.innerHTML = '<form id="add"><input name="owner" placeholder="owner" required>'
        + '<input name="name" placeholder="repository" required><input name="defaultBranch" placeholder="main">'
        + '<button>Add repository</button></form>'
        + (repositories.length
          ? '<table><thead><tr><th>Repository</th><th>Provider</th><th>Default branch</th><th></th></tr></thead><tbody>'
            + repositories.map((repository) =>
              '<tr><td>' + esc(repository.owner) + '/' + esc(repository.name) + '</td><td>' + esc(repository.provider) + '</td>'
              + '<td>' + esc(repository.defaultBranch) + '</td>'
              + '<td><button data-remove="' + esc(repository.id) + '">Remove</button></td></tr>').join('')
            + '</tbody></table>'
          : '<div class="empty">No repositories yet.</div>');
      panel.querySelector('#add').onsubmit = async (event) => {
        event.preventDefault();
        await api('/v1/projects/' + projectId + '/repositories', {
          method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
        await render();
      };
    } else if (current === 'Environments') {
      const { environments } = await api('/v1/projects/' + projectId + '/environments');
      panel.innerHTML = '<form id="add"><select name="name"><option>development</option><option>staging</option><option>production</option></select>'
        + '<input name="provider" placeholder="provider"><button>Create environment</button></form>'
        + (environments.length
          ? '<table><thead><tr><th>Environment</th><th>Provider</th><th>Current state</th></tr></thead><tbody>'
            + environments.map((environment) =>
              '<tr><td>' + esc(environment.name) + '</td><td>' + esc(environment.provider || '—') + '</td>'
              + '<td class="muted">' + esc(JSON.stringify(environment.currentState || {})) + '</td></tr>').join('')
            + '</tbody></table>'
          : '<div class="empty">No environments yet.</div>');
      panel.querySelector('#add').onsubmit = async (event) => {
        event.preventDefault();
        await api('/v1/projects/' + projectId + '/environments', {
          method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
        await render();
      };
    } else if (current === 'Desired State') {
      const [{ repositories }, desired] = await Promise.all([
        api('/v1/projects/' + projectId + '/repositories'),
        api('/v1/projects/' + projectId + '/desired-state').catch(() => null),
      ]);
      panel.innerHTML = '<p class="lede">What should be true. Factory works out the steps.</p>'
        + '<form id="desired">'
        + '<select name="sourceRepositoryId">' + repositories.map((repository) =>
            '<option value="' + esc(repository.id) + '"' + (desired && desired.sourceRepositoryId === repository.id ? ' selected' : '') + '>'
            + esc(repository.owner) + '/' + esc(repository.name) + '</option>').join('') + '</select>'
        + '<input name="sourceBranch" placeholder="branch" value="' + esc(desired?.sourceBranch || '') + '">'
        + '<select name="deploymentEnabled"><option value="false"' + (desired?.deploymentEnabled ? '' : ' selected') + '>deployment disabled</option>'
        + '<option value="true"' + (desired?.deploymentEnabled ? ' selected' : '') + '>deployment enabled</option></select>'
        + '<input name="targetProvider" placeholder="target provider" value="' + esc(desired?.targetProvider || '') + '">'
        + '<input name="healthRequirement" placeholder="health requirement" value="' + esc(desired?.healthRequirement || '') + '">'
        + '<button>Save desired state</button></form><p id="saved" class="muted"></p>';
      panel.querySelector('#desired').onsubmit = async (event) => {
        event.preventDefault();
        const data = Object.fromEntries(new FormData(event.target));
        data.deploymentEnabled = data.deploymentEnabled === 'true';
        await api('/v1/projects/' + projectId + '/desired-state', { method: 'PUT', body: JSON.stringify(data) });
        panel.querySelector('#saved').textContent = 'Desired state saved';
      };
    } else if (current === 'Actions') {
      const { actions } = await api('/v1/projects/' + projectId + '/actions');
      panel.innerHTML = '<form id="plan"><input name="type" placeholder=".flow operation, e.g. repo-echo" required>'
        + '<input name="intent" placeholder="intent"><button>Plan action</button></form>'
        + (actions.length
          ? '<table><thead><tr><th>Action</th><th>Status</th><th>Provider</th><th>Updated</th></tr></thead><tbody>'
            + actions.map((action) =>
              '<tr><td><a href="/factory/actions/' + esc(action.id) + '">' + esc(action.type) + '</a>'
              + '<div class="muted">' + esc(action.intent) + '</div></td>'
              + '<td>' + statusPill(action.status) + '</td><td>' + esc(action.executionProvider || '—') + '</td>'
              + '<td class="muted">' + esc(action.updatedAt) + '</td></tr>').join('')
            + '</tbody></table>'
          : '<div class="empty">No actions yet.</div>');
      panel.querySelector('#plan').onsubmit = async (event) => {
        event.preventDefault();
        await api('/v1/projects/' + projectId + '/actions', {
          method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
        await render();
      };
    } else {
      const { runs } = await api('/v1/projects/' + projectId + '/runs');
      panel.innerHTML = runs.length
        ? '<table><thead><tr><th>Run</th><th>Operation</th><th>Status</th><th>Evidence</th></tr></thead><tbody>'
          + runs.map((run) => '<tr><td><a href="/factory/runs/' + esc(run.id) + '">' + esc(run.id) + '</a></td>'
            + '<td>' + esc(run.operation) + '</td><td>' + statusPill(run.status) + '</td>'
            + '<td class="muted">' + esc(run.evidenceId || '—') + '</td></tr>').join('')
          + '</tbody></table>'
        : '<div class="empty">No runs yet.</div>';
    }
  } catch (error) { fail(panel, error); }
}
window.addEventListener('hashchange', () => { current = location.hash.replace('#','') || 'Overview'; render(); });
await render();
`);
}

export function actionsPage(): string {
  return productPage('actions', 'Actions', `
<h1>Actions</h1>
<p class="lede">What Factory is going to do to make desired state true.</p>
<div id="actions"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#actions');
const ORDER = ['planned','awaiting-approval','authorized','running','succeeded','failed'];
try {
  const { actions } = await api('/v1/actions');
  target.innerHTML = ORDER.map((status) => {
    const group = actions.filter((action) => action.status === status);
    if (!group.length) return '';
    return '<h2>' + esc(status) + ' <span class="muted">(' + group.length + ')</span></h2>'
      + '<table><thead><tr><th>Action</th><th>Project</th><th>Provider</th><th>Updated</th></tr></thead><tbody>'
      + group.map((action) =>
        '<tr><td><a href="/factory/actions/' + esc(action.id) + '">' + esc(action.type) + '</a>'
        + '<div class="muted">' + esc(action.intent) + '</div></td>'
        + '<td><a href="/factory/projects/' + esc(action.projectId) + '">' + esc(action.projectId) + '</a></td>'
        + '<td>' + esc(action.executionProvider || '—') + '</td>'
        + '<td class="muted">' + esc(action.updatedAt) + '</td></tr>').join('')
      + '</tbody></table>';
  }).join('') || '<div class="empty">No actions yet.</div>';
} catch (error) { fail(target, error); }
`);
}

export function actionPage(actionId: string): string {
  return productPage('actions', 'Action', `
<h1 id="type">Action</h1>
<p class="lede" id="intent"></p>
<div id="detail"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const actionId = ${scriptLiteral(actionId)};
const detail = document.querySelector('#detail');
async function render() {
  try {
    const action = await api('/v1/actions/' + actionId);
    document.querySelector('#type').innerHTML = esc(action.type) + ' ' + statusPill(action.status);
    document.querySelector('#intent').textContent = action.intent;
    const authority = action.authority || {};
    const verification = action.verification || [];
    detail.innerHTML =
      '<h2>Plan</h2><ol class="plan">' + (action.plan || []).map((step) =>
        '<li>' + esc(step.summary) + (step.detail ? ' <span class="muted">— ' + esc(step.detail) + '</span>' : '')
        + (step.basis ? '<div class="basis">from ' + esc(step.basis) + '</div>' : '') + '</li>').join('')
      + '</ol>'
      + '<h2>Authority</h2><div class="grid">'
        + '<div class="card"><h3>Principal</h3><p>' + esc(authority.principal || '—') + '</p></div>'
        + '<div class="card"><h3>Application</h3><p>' + esc(authority.application || '—') + '</p></div>'
        + '<div class="card"><h3>Delegation</h3><p>' + esc(authority.delegation || '—') + '</p></div>'
        + '<div class="card"><h3>Authorization decision</h3><p>' + esc(authority.authorizationDecisionId || '—') + '</p></div>'
      + '</div>'
      + '<h2>Execution</h2><div class="grid">'
        + '<div class="card"><h3>Provider</h3><p>' + esc(action.executionProvider || '—') + '</p></div>'
        + '<div class="card"><h3>Environment</h3><p>' + esc(action.environmentId || '—') + '</p></div>'
        + '<div class="card"><h3>Status</h3><p>' + statusPill(action.status) + '</p></div>'
      + '</div>'
      + '<h2>Verification</h2>' + (verification.length
        ? '<table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>'
          + verification.map((check) => '<tr><td>' + esc(check.name) + '</td><td>' + statusPill(check.status) + '</td>'
            + '<td class="muted">' + esc(check.detail || '') + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">Not verified yet.</div>')
      + '<h2>Evidence</h2>' + (action.runId
        ? '<p><a href="/factory/runs/' + esc(action.runId) + '">Run ' + esc(action.runId) + '</a> · '
          + '<a href="/v1/runs/' + esc(action.runId) + '/evidence">durable evidence</a></p>'
        : '<div class="empty">No run yet.</div>')
      + (['planned','awaiting-approval'].includes(action.status)
        ? '<p><button id="run">Authorize and run</button></p>' : '')
      + (action.discovery ? '<details><summary>Repository discovery</summary><pre>'
        + esc(JSON.stringify(action.discovery, null, 2)) + '</pre></details>' : '');
    const run = detail.querySelector('#run');
    if (run) run.onclick = async () => {
      run.disabled = true;
      try { await api('/v1/actions/' + actionId + '/run', { method: 'POST' }); await render(); }
      catch (error) { fail(detail, error); }
    };
  } catch (error) { fail(detail, error); }
}
await render();
`);
}

export function runsPage(): string {
  return productPage('runs', 'Runs', `
<h1>Runs</h1>
<p class="lede">What actually happened.</p>
<div id="runs"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#runs');
try {
  const data = await api('/v1/overview');
  target.innerHTML = data.recentActivity.length
    ? '<table><thead><tr><th>Run</th><th>Action</th><th>Operation</th><th>Status</th><th>Completed</th></tr></thead><tbody>'
      + data.recentActivity.map((run) =>
        '<tr><td><a href="/factory/runs/' + esc(run.id) + '">' + esc(run.id) + '</a></td>'
        + '<td>' + (run.actionId ? '<a href="/factory/actions/' + esc(run.actionId) + '">' + esc(run.actionId) + '</a>' : '—') + '</td>'
        + '<td>' + esc(run.operation) + '</td><td>' + statusPill(run.status) + '</td>'
        + '<td class="muted">' + esc(run.completedAt || '—') + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">No runs yet.</div>';
} catch (error) { fail(target, error); }
`);
}

export function runPage(runId: string): string {
  return productPage('runs', 'Run', `
<h1 id="title">Run</h1>
<p class="lede" id="subtitle"></p>
<div id="detail"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const runId = ${scriptLiteral(runId)};
const detail = document.querySelector('#detail');
try {
  const run = await api('/v1/runs/' + runId);
  const evidence = await api('/v1/runs/' + runId + '/evidence').catch(() => null);
  const action = run.actionId ? await api('/v1/actions/' + run.actionId).catch(() => null) : null;
  document.querySelector('#title').innerHTML = esc(run.operation) + ' ' + statusPill(run.status);
  document.querySelector('#subtitle').textContent = run.id;

  // The lifecycle is the run. Logs are supporting detail, folded away below.
  const phase = (name, state, body) => '<div class="phase"><div class="name">' + name + '</div>'
    + '<div>' + statusPill(state) + '</div><div class="muted">' + body + '</div></div>';
  const authorized = evidence && evidence.authorizedApplication;
  detail.innerHTML = '<div class="phases">'
    + phase('Planning', action ? 'succeeded' : 'skipped', action ? esc(action.plan.length) + ' steps' : 'no action')
    + phase('Authorization', run.authorizationDecisionId ? 'passed' : 'failed',
        esc(run.authorizationDecisionId || 'no decision recorded'))
    + phase('Execution', run.status, esc(run.executionProvider || evidence?.executionMode || '—'))
    + phase('Verification', (action?.verification || []).some((c) => c.status === 'failed') ? 'failed'
        : action?.verification?.length ? 'passed' : 'skipped',
        esc((action?.verification || []).length) + ' checks')
    + phase('Evidence', evidence ? 'passed' : 'failed', esc(evidence ? evidence.finalResult : 'none'))
    + '</div>'
    + '<h2>Authority</h2><div class="grid">'
      + '<div class="card"><h3>Principal</h3><p>' + esc(run.principal) + '</p></div>'
      + '<div class="card"><h3>Application</h3><p>' + esc(authorized?.applicationId || run.applicationId || '—') + '</p></div>'
      + '<div class="card"><h3>Delegation</h3><p>' + esc(authorized?.delegationId || run.delegationId || '—') + '</p></div>'
      + '<div class="card"><h3>Tenant</h3><p>' + esc(run.tenantId || '—') + '</p></div>'
    + '</div>'
    + (evidence ? '<details><summary>Execution logs</summary><pre>' + esc(evidence.stdout || '') + esc(evidence.stderr || '') + '</pre></details>' : '');
} catch (error) { fail(detail, error); }
`);
}

export function providersPage(): string {
  return productPage('providers', 'Providers', `
<h1>Providers</h1>
<p class="lede">Execution providers and the capabilities <code>.flow</code> declares for each.</p>
<div id="providers"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#providers');
try {
  const { providers } = await api('/v1/providers');
  target.innerHTML = providers.length ? '<div class="grid">' + providers.map((provider) =>
    '<div class="card"><h3>' + esc(provider.name) + ' ' + statusPill(provider.connectionState) + '</h3>'
    + '<p class="muted">' + esc(provider.connectionDetail) + '</p>'
    + '<p><strong>Capabilities</strong><br>' + provider.capabilities.map(esc).join('<br>') + '</p>'
    + '<p><strong>Operates on</strong><br>' + provider.operatesOn.map(esc).join(', ') + '</p>'
    + '<p><strong>Operations</strong><br>' + provider.operations.map((operation) => esc(operation.operation)).join('<br>') + '</p>'
    + '</div>').join('') + '</div>'
    : '<div class="empty">No providers are declared in .flow.</div>';
} catch (error) { fail(target, error); }
`);
}

export function settingsPage(): string {
  return productPage('settings', 'Settings', `
<h1>Settings</h1>
<p class="lede">Factory's authority and the infrastructure it composes.</p>
<section><h2>Authority association</h2><div id="connection"><p class="muted">Loading…</p></div></section>
<section><h2>Infrastructure</h2>
<div class="grid">
  <div class="card"><h3>AppPort Services</h3><p class="muted">Configuration, secrets, API keys, jobs, and webhooks.</p><a href="/services">Open AppPort Services</a></div>
  <div class="card"><h3>Runtime</h3><p class="muted">Health and composition.</p><a href="/health">Health</a></div>
</div></section>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#connection');
try {
  const connection = await api('/v1/connection').catch(async (error) => { throw error; });
  target.innerHTML = '<div class="card"><h3>' + statusPill(connection.status) + '</h3>'
    + '<p class="muted">' + esc(connection.reason || '') + '</p>'
    + '<pre>' + esc(JSON.stringify(connection, null, 2)) + '</pre></div>';
} catch (error) { fail(target, error); }
`);
}
