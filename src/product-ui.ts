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
  { id: 'graphs', label: 'Operations', href: '/factory/graphs' },
  { id: 'work', label: 'Requested work', href: '/factory/work' },
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
.reality{margin-bottom:2rem}
.reality th{text-transform:none;letter-spacing:0;font-size:.92rem;color:var(--fg);width:8rem}
tr.drift td,tr.drift th{background:color-mix(in srgb,var(--warn) 12%,transparent)}
.banner{border:1px solid var(--line);border-left-width:3px;border-radius:8px;padding:.75rem;background:var(--panel)}
.banner p{margin:.25rem 0}
.banner.drift{border-left-color:var(--warn)}
.recon{margin-top:.75rem;border:1px solid var(--line);border-radius:8px;padding:.75rem;background:var(--panel)}
.provider{margin-bottom:1rem}.caps{list-style:none;padding:0;margin:.25rem 0}.caps li{margin:.2rem 0}.caps details{margin:0;padding:.4rem .6rem}
.nodes{display:flex;flex-direction:column;align-items:stretch;gap:0;margin:.75rem 0}
.node{border:1px solid var(--line);border-radius:8px;padding:.7rem;background:var(--panel)}
.node.completed{border-left:3px solid var(--ok)}.node.running{border-left:3px solid var(--accent)}
.node.failed{border-left:3px solid var(--bad)}.node.blocked,.node.awaiting-approval{border-left:3px solid var(--warn)}
.node-head{font-weight:600}.mark{font-family:ui-monospace,monospace}
.arrow{text-align:center;color:var(--muted);padding:.15rem}
.recon h3{margin:0 0 .4rem;font-size:.95rem}
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
/*
 * Shared helpers live only on window.factory. Each page script then takes the
 * ones it uses with a single top-level declaration. Declaring them here at
 * module scope as well would redeclare them in the same module, which is a
 * parse error that stops the whole page script before its first line runs.
 */
window.factory = (() => {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.message || ('Request failed with HTTP ' + response.status));
    return body;
  }
  function statusPill(status) {
    const tone = ['succeeded','completed','associated','passed','ready','healthy','reconciled','executed','converged'].includes(status) ? 'ok'
      : ['failed','unassociated','unverified','execution-failed','verification-failed','error'].includes(status) ? 'bad'
      : ['awaiting-approval','requires-connection','requires-executable','drifted','autonomy-denied','authority-unavailable','unknown'].includes(status) ? 'warn' : '';
    return '<span class="pill ' + tone + '">' + esc(status) + '</span>';
  }
  function fail(node, error) {
    node.innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
  }
  return { api, esc, statusPill, fail };
})();
`;

export function overviewPage(): string {
  return productPage('overview', 'Overview', `
<h1>Overview</h1>
<p class="lede">What Factory is keeping true, what it is changing, and on whose authority.</p>
<section><h2>Authority</h2><div id="authority"><p class="muted">Loading…</p></div></section>
<section><h2>Keeping in sync</h2><div id="sync"><p class="muted">Loading…</p></div></section>
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

  const sync = await api('/v1/reconciliation').catch(() => null);
  document.querySelector('#sync').innerHTML = sync && sync.environments.length
    ? '<p>' + sync.summary.total + ' environments · ' + sync.summary.healthy + ' healthy · '
      + sync.summary.drifted + ' drifted · ' + sync.summary.awaitingApproval + ' awaiting approval · '
      + sync.summary.failed + ' failed · ' + sync.summary.disabled + ' disabled</p>'
      + '<table><thead><tr><th>Environment</th><th>Status</th><th>Schedule</th><th>Last observed</th><th>Action</th></tr></thead><tbody>'
      + sync.environments.map((entry) =>
        '<tr><td><a href="/factory/projects/' + esc(entry.projectId) + '#Reality">'
        + esc(entry.projectName || entry.projectId) + ' / ' + esc(entry.environmentName || entry.environmentId) + '</a></td>'
        + '<td>' + statusPill(entry.enabled ? entry.status : 'disabled') + '</td>'
        + '<td class="muted">' + esc(entry.schedule) + '</td>'
        + '<td class="muted">' + esc(entry.lastObservedAt || 'never') + '</td>'
        + '<td>' + (entry.action
            ? '<a href="/factory/actions/' + esc(entry.action.id) + '">' + esc(entry.action.status) + '</a>'
            : '—') + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">Factory is not continuously reconciling anything yet.</div>';

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
const TABS = ['Overview','Reality','Repositories','Environments','Desired State','Actions','Operations','Runs'];
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
    } else if (current === 'Reality') {
      const { environments } = await api('/v1/projects/' + projectId + '/reality');
      panel.innerHTML = environments.length ? environments.map((report) => {
        const rows = report.fields.map((field) =>
          '<tr' + (field.drifted ? ' class="drift"' : '') + '><th>' + esc(field.label) + '</th>'
          + '<td>' + esc(field.desired ?? '—') + '</td><td>' + esc(field.current ?? '—') + '</td></tr>').join('');
        return '<section class="reality"><h2>' + esc(report.environmentName) + ' ' + statusPill(report.status) + '</h2>'
          + '<table><thead><tr><th></th><th>Desired</th><th>Current</th></tr></thead><tbody>' + rows + '</tbody></table>'
          + '<div class="' + (report.status === 'drifted' ? 'banner drift' : 'banner') + '">'
          + report.explanation.map((line) => '<p>' + esc(line) + '</p>').join('')
          + (report.proposal
            ? '<p><strong>Action available</strong><br>' + esc(report.proposal.intent) + '</p>'
              + '<button data-reconcile="' + esc(report.environmentId) + '">Review Action</button>'
            : '') + '</div>'
          + '<div class="recon" data-env="' + esc(report.environmentId) + '"></div></section>';
      }).join('') : '<div class="empty">No environments yet.</div>';
      const { environments: records } = await api('/v1/reconciliation');
      environments.forEach((report) => {
        const record = records.find((entry) => entry.environmentId === report.environmentId);
        const host = panel.querySelector('[data-env="' + report.environmentId + '"]');
        if (!host) return;
        host.innerHTML = '<h3>Reconciliation</h3>'
          + (record
            ? '<p>' + statusPill(record.enabled ? record.status : 'disabled') + ' ' + esc(record.schedule) + '</p>'
              + '<p class="muted">Last observed: ' + esc(record.lastObservedAt || 'never')
              + '<br>Last reconciled: ' + esc(record.lastReconciledAt || 'never')
              + '<br>Next due: ' + esc(record.nextDueAt || '—') + '</p>'
              + (record.lastError ? '<p class="muted">' + esc(record.lastError) + '</p>' : '')
              + (record.graphId ? '<p><a href="/factory/graphs/' + esc(record.graphId) + '">Action graph</a></p>' : '')
              + (record.action
                ? '<p><strong>Action</strong><br><a href="/factory/actions/' + esc(record.action.id) + '">'
                  + esc(record.action.intent) + '</a> ' + statusPill(record.action.status) + '</p>'
                  + '<p class="muted">Autonomy: '
                  + esc(record.action.autonomy ? (record.action.autonomy.allowed ? 'authorized' : 'denied') : 'not asked')
                  + '</p>'
                : '')
              + '<p><button data-toggle="' + esc(report.environmentId) + '" data-enabled="' + record.enabled + '">'
              + (record.enabled ? 'Disable' : 'Enable') + '</button> '
              + '<button data-now="' + esc(report.environmentId) + '">Reconcile Now</button></p>'
            : '<p class="muted">Not continuously reconciled.</p>'
              + '<form data-enable="' + esc(report.environmentId) + '">'
              + '<input name="interval" placeholder="15m" value="15m">'
              + '<button>Enable continuous reconciliation</button></form>');
      });
      panel.querySelectorAll('[data-enable]').forEach((form) => {
        form.onsubmit = async (event) => {
          event.preventDefault();
          try {
            await api('/v1/projects/' + projectId + '/environments/' + form.dataset.enable + '/reconciliation',
              { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
            await render();
          } catch (error) { fail(panel, error); }
        };
      });
      panel.querySelectorAll('[data-toggle]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            await api('/v1/projects/' + projectId + '/environments/' + button.dataset.toggle + '/reconciliation',
              { method: 'PATCH', body: JSON.stringify({ enabled: button.dataset.enabled !== 'true' }) });
            await render();
          } catch (error) { fail(panel, error); }
        };
      });
      panel.querySelectorAll('[data-now]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = 'Reconciling…';
          try {
            // The same engine the scheduler calls, asked to run now.
            await api('/v1/projects/' + projectId + '/environments/' + button.dataset.now + '/reconcile-now',
              { method: 'POST', body: JSON.stringify({}) });
            await render();
          } catch (error) { fail(panel, error); }
        };
      });
      panel.querySelectorAll('[data-reconcile]').forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          try {
            const result = await api(
              '/v1/projects/' + projectId + '/environments/' + button.dataset.reconcile + '/reconcile',
              { method: 'POST', body: JSON.stringify({}) });
            if (result.action) location.href = '/factory/actions/' + result.action.id;
            else await render();
          } catch (error) { fail(panel, error); }
        };
      });
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
    } else if (current === 'Operations') {
      const { graphs } = await api('/v1/action-graphs?projectId=' + encodeURIComponent(projectId));
      const group = (label, predicate) => {
        const rows = graphs.filter(predicate);
        return rows.length ? '<h2>' + label + ' <span class="muted">(' + rows.length + ')</span></h2>'
          + '<table><thead><tr><th>Graph</th><th>Origin</th><th>Status</th><th>Updated</th></tr></thead><tbody>'
          + rows.map((graph) => '<tr><td><a href="/factory/graphs/' + esc(graph.id) + '">' + esc(graph.id) + '</a></td>'
            + '<td class="muted">' + esc(graph.origin?.kind || 'manual') + '</td><td>' + statusPill(graph.status) + '</td>'
            + '<td class="muted">' + esc(graph.updatedAt) + '</td></tr>').join('') + '</tbody></table>' : '';
      };
      panel.innerHTML = (group('Active', (g) => ['ready','running','planned'].includes(g.status))
        + group('Blocked', (g) => g.status === 'blocked')
        + group('Failed', (g) => g.status === 'failed')
        + group('Reconciliation-triggered', (g) => g.origin?.kind === 'continuous-reconciliation')
        + group('Recently completed', (g) => g.status === 'completed')) || '<div class="empty">No operations yet.</div>';
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
const ORDER = ['planned','awaiting-approval','authorized','running','executed','verifying','unknown','succeeded','failed'];
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
    const drift = action.drift;
    const autonomyState = !action.autonomy ? 'not asked'
      : action.autonomy.allowed ? 'authorized'
      : /unavailable|unreachable|could not|no AuthBoundry session/i.test(action.autonomy.reason)
        ? 'AuthBoundry unavailable' : 'denied';
    const origin = action.origin === 'continuous-reconciliation'
      ? 'Continuous reconciliation' : 'Manual';
    const execution = action.execution || {};
    const hasRun = Boolean(action.runId && execution.startedAt);
    const bound = (action.preflight?.checks || []).find((check) => check.name === 'resource bound')?.detail || '';
    // Phases are derived from durable status only; nothing here is client state.
    const reachedIndex = { planned: 0, 'awaiting-approval': 0, authorized: 1, running: 2, executed: 3, verifying: 4, unknown: 2, succeeded: 5, failed: hasRun ? (action.outcome === 'verification-failed' || action.outcome === 'verification-unavailable' ? 4 : 2) : action.preflight ? 1 : 0 }[action.status] ?? 0;
    const PHASES = ['Planned', 'Authorized', 'Executing', 'Executed', 'Verifying', 'Succeeded']
      .map((name, index) => [name, index <= reachedIndex && !(action.status === 'failed' && index === 5), index === reachedIndex && action.status !== 'succeeded' && action.status !== 'failed']);
    detail.innerHTML =
      '<h2>Origin</h2><div class="grid">'
        + '<div class="card"><h3>Origin</h3><p>' + esc(origin)
          + (action.graphId ? '<br><a href="/factory/graphs/' + esc(action.graphId) + '">Action graph</a>' : '')
          + ((action.dependsOn || []).length ? '<br><span class="muted">after ' + action.dependsOn.map(esc).join(', ') + '</span>' : '')
          + ((action.blockedBy || []).length ? '<br><span class="muted">blocked by ' + action.blockedBy.map(esc).join(', ') + '</span>' : '')
          + (action.outcome ? '<br>' + statusPill(action.outcome) : '') + '</p></div>'
        + '<div class="card"><h3>Desired state revision</h3><p class="muted">'
          + esc(action.desiredStateRevision || '—') + '</p></div>'
        + '<div class="card"><h3>Observed reality revision</h3><p class="muted">'
          + esc(action.observedStateRevision || '—') + '</p></div>'
      + '</div>'
      +
      (drift ? '<h2>Why</h2><div class="banner drift">'
        + drift.explanation.map((line) => '<p>' + esc(line) + '</p>').join('')
        + '<p class="muted">Observed ' + esc(drift.observedAt) + '</p></div>' : '')
      + '<h2>Plan</h2><ol class="plan">' + (action.plan || []).map((step) =>
        '<li>' + esc(step.summary) + (step.detail ? ' <span class="muted">— ' + esc(step.detail) + '</span>' : '')
        + (step.basis ? '<div class="basis">from ' + esc(step.basis) + '</div>' : '') + '</li>').join('')
      + '</ol>'
      + '<h2>Authority</h2><div class="grid">'
        + '<div class="card"><h3>Autonomous execution</h3><p>'
          + statusPill(autonomyState === 'authorized' ? 'ready'
              : autonomyState === 'not asked' ? 'unknown' : 'awaiting-approval')
          + ' ' + esc(autonomyState) + '</p>'
          + '<p class="muted">' + esc(action.autonomy?.reason || 'not asked') + '</p></div>'
        + (action.approvedBy ? '<div class="card"><h3>Approved by</h3><p>' + esc(action.approvedBy) + '</p></div>' : '')
        + '<div class="card"><h3>Principal</h3><p>' + esc(authority.principal || '—') + '</p></div>'
        + '<div class="card"><h3>Application</h3><p>' + esc(authority.application || '—') + '</p></div>'
        + '<div class="card"><h3>Delegation</h3><p>' + esc(authority.delegation || '—') + '</p></div>'
        + '<div class="card"><h3>Authorization decision</h3><p>' + esc(authority.authorizationDecisionId || '—') + '</p></div>'
      + '</div>'
      + '<h2>Operation</h2><div class="grid">'
        + '<div class="card"><h3>Capability</h3><p>' + esc(action.capability || '—') + '</p></div>'
        + '<div class="card"><h3>Provider</h3><p>' + esc(action.provider || '—') + '</p>'
          + (action.verificationRequires ? '<p class="muted">verified by ' + esc(action.verificationRequires) + '</p>' : '') + '</div>'
        + '<div class="card"><h3>Resource</h3><p>' + esc(action.resource || '—') + '</p></div>'
        + '<div class="card"><h3>Operation</h3><p>' + esc(action.operation || '—') + '</p></div>'
      + '</div>'
      + '<h2>Execution</h2>'
      + '<div class="phases">' + PHASES.map(([name, reached, current]) =>
          '<div class="phase"><div class="name">' + name + '</div><div>' + statusPill(reached ? (current ? 'running' : 'passed') : 'skipped')
          + '</div><div class="muted">' + (reached ? (current ? 'now' : 'done') : 'not reached') + '</div></div>').join('') + '</div>'
      + (action.status === 'unknown'
          ? '<div class="banner"><p><strong>Outcome uncertain — Factory is verifying external state before retrying.</strong></p>'
            + '<p class="muted">' + esc(action.failure?.reason || 'The provider may have acted; Factory did not see the result.') + '</p>'
            + '<p><button id="resolve">Check reality now</button></p></div>'
          : action.failure ? '<div class="banner drift"><p><strong>' + esc(action.failure.outcome) + '</strong> in ' + esc(action.failure.phase) + '</p><p class="muted">' + esc(action.failure.reason) + '</p></div>' : '')
      + (action.cancellation ? '<div class="banner"><p><strong>Cancellation</strong> ' + esc(action.cancellation.stage) + ' · effect: ' + esc(action.cancellation.effect) + '</p><p class="muted">' + esc(action.cancellation.detail) + '</p></div>' : '')
      + '<div class="grid">'
        + '<div class="card"><h3>Provider</h3><p>' + esc(action.provider || action.executionProvider || '—') + '</p></div>'
        + '<div class="card"><h3>Operation</h3><p>' + esc(action.operation || '—') + '</p></div>'
        + '<div class="card"><h3>Resource</h3><p>' + esc(action.resource || '—') + '</p>'
          + (bound ? '<p class="muted">' + esc(bound) + '</p>' : '') + '</div>'
        + '<div class="card"><h3>Started</h3><p>' + esc(execution.startedAt || '—') + '</p>'
          + (execution.requestedAt ? '<p class="muted">requested ' + esc(execution.requestedAt) + '</p>' : '') + '</div>'
        + '<div class="card"><h3>Duration</h3><p>' + (execution.durationMs !== undefined ? esc(execution.durationMs) + ' ms' : '—') + '</p>'
          + (execution.completedAt ? '<p class="muted">completed ' + esc(execution.completedAt) + '</p>' : '') + '</div>'
        + '<div class="card"><h3>Execution result</h3><p>' + (hasRun
            ? statusPill(execution.providerStatus || (execution.exitCode === 0 ? 'succeeded' : 'failed'))
              + ' <span class="muted">exit ' + esc(execution.exitCode === undefined ? '—' : execution.exitCode)
              + (execution.terminationReason ? ' · ' + esc(execution.terminationReason) : '') + '</span>'
            : '<span class="muted">not run</span>') + '</p></div>'
        + '<div class="card"><h3>Provider reference</h3><p>' + esc(execution.providerOperationId || '—') + '</p>'
          + (execution.observedRevision ? '<p class="muted">observed revision ' + esc(execution.observedRevision) + '</p>' : '') + '</div>'
        + '<div class="card"><h3>Environment</h3><p>' + esc(action.environmentId || '—') + '</p></div>'
      + '</div>'
      + (action.preflight ? '<details><summary>Preflight (' + esc(action.preflight.checks.length) + ' checks'
          + (action.preflight.passedAt ? ', passed' : action.preflight.failedAt ? ', failed' : '') + ')</summary>'
          + '<table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>'
          + action.preflight.checks.map((check) => '<tr><td>' + esc(check.name) + '</td><td>' + statusPill(check.status) + '</td><td class="muted">' + esc(check.detail || '') + '</td></tr>').join('')
          + '</tbody></table></details>' : '')
      + '<h2>Verification</h2>' + (verification.length
        ? '<table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>'
          + verification.map((check) => '<tr><td>' + esc(check.name) + '</td><td>' + statusPill(check.status) + '</td>'
            + '<td class="muted">' + esc(check.detail || '') + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">Not verified yet.</div>')
      + '<h2>Evidence</h2>' + (action.runId
        ? '<p><a href="/factory/runs/' + esc(action.runId) + '">Run ' + esc(action.runId) + '</a> · '
          + '<a href="/v1/runs/' + esc(action.runId) + '/evidence">durable evidence</a></p>'
        : '<div class="empty">No run yet.</div>')
      + (action.status === 'awaiting-approval'
        ? '<div class="banner drift"><p><strong>Autonomous execution not authorized</strong></p>'
          + '<p class="muted">' + esc(action.autonomy?.reason || 'Factory could not ask the authority.') + '</p>'
          + '<p><button id="run">Approve &amp; Run</button></p></div>'
        : action.status === 'planned' && action.outcome !== 'cancelled' ? '<p><button id="run">Run</button></p>' : '')
      + (['authorized','running','executed','verifying'].includes(action.status) || (action.status === 'planned' && action.outcome !== 'cancelled')
          ? '<p><button id="cancel">Cancel</button></p>' : '')
      + (action.discovery ? '<details><summary>Repository discovery</summary><pre>'
        + esc(JSON.stringify(action.discovery, null, 2)) + '</pre></details>' : '');
    const run = detail.querySelector('#run');
    if (run) run.onclick = async () => {
      run.disabled = true;
      try { await api('/v1/actions/' + actionId + '/run', { method: 'POST' }); await render(); }
      catch (error) { fail(detail, error); }
    };
    const cancel = detail.querySelector('#cancel');
    if (cancel) cancel.onclick = async () => {
      if (!confirm('Cancel this action?')) return;
      try { await api('/v1/actions/' + actionId + '/cancel', { method: 'POST' }); await render(); }
      catch (error) { fail(detail, error); }
    };
    const resolve = detail.querySelector('#resolve');
    if (resolve) resolve.onclick = async () => {
      resolve.disabled = true;
      try { await api('/v1/actions/' + actionId + '/resolve', { method: 'POST' }); await render(); }
      catch (error) { fail(detail, error); }
    };
    if (['authorized','running','executed','verifying'].includes(action.status)) setTimeout(render, 3000);
    if (action.status === 'unknown') setTimeout(render, 10000);
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
    + phase('Execution', run.status === 'unknown' ? 'unknown' : run.status, esc(run.executionProvider || evidence?.executionMode || '—')
        + (evidence?.execution ? ' · ' + esc(evidence.execution.terminationReason) + (evidence.exitCode !== null && evidence.exitCode !== undefined ? ' · exit ' + esc(evidence.exitCode) : '') : ''))
    + phase('Verification', (action?.verification || []).some((c) => c.status === 'failed') ? 'failed'
        : action?.verification?.length ? 'passed' : 'skipped',
        esc((action?.verification || []).length) + ' checks')
    + phase('Evidence', evidence ? 'passed' : 'failed', esc(evidence ? evidence.finalResult : 'none'))
    + '</div>'
    + (run.status === 'unknown' ? '<div class="banner"><p><strong>Outcome uncertain — Factory is verifying external state before retrying.</strong></p>'
        + '<p class="muted">' + esc(run.uncertainty?.reason || '') + (run.uncertainty?.invocationMayHaveOccurred ? ' · the provider may have been invoked' : '')
        + (run.uncertainty?.retrySafe ? ' · repeating is safe' : ' · repeating is not known to be safe') + '</p>'
        + ((run.uncertainty?.observations || []).length ? '<p class="muted">observations: ' + run.uncertainty.observations.map((o) => esc(o.at) + ' ' + esc(o.outcome) + ' — ' + esc(o.detail)).join('; ') + '</p>' : '') + '</div>' : '')
    + '<h2>Execution</h2><div class="grid">'
      + '<div class="card"><h3>Owner</h3><p>' + esc(run.executionOwner || '—') + '</p>'
        + '<p class="muted">' + (run.leaseExpiresAt ? (Date.parse(run.leaseExpiresAt) > Date.now() ? 'lease live until ' : 'lease expired at ') + esc(run.leaseExpiresAt) : 'no lease held') + '</p></div>'
      + '<div class="card"><h3>Attempt</h3><p>' + esc(run.attempt || 1) + '</p>' + (run.heartbeatAt ? '<p class="muted">heartbeat ' + esc(run.heartbeatAt) + '</p>' : '') + '</div>'
      + '<div class="card"><h3>Elapsed</h3><p>' + (run.startedAt ? esc(Math.round(((run.completedAt ? Date.parse(run.completedAt) : Date.now()) - Date.parse(run.startedAt)) / 1000)) + ' s' : '—') + '</p>'
        + (run.completedAt ? '<p class="muted">completed ' + esc(run.completedAt) + '</p>' : run.startedAt ? '<p class="muted">since ' + esc(run.startedAt) + '</p>' : '') + '</div>'
      + '<div class="card"><h3>Provider</h3><p>' + esc(action?.provider || run.executionProvider || '—') + '</p><p class="muted">' + esc(action?.capability || run.operation) + (action?.resource ? ' · ' + esc(action.resource) : '') + '</p></div>'
      + '<div class="card"><h3>Provider reference</h3><p>' + esc(run.providerOperationId || evidence?.providerResult?.providerOperationId || '—') + '</p></div>'
    + '</div>'
    + '<h2>Authority</h2><div class="grid">'
      + '<div class="card"><h3>Principal</h3><p>' + esc(run.principal) + '</p></div>'
      + '<div class="card"><h3>Application</h3><p>' + esc(authorized?.applicationId || run.applicationId || '—') + '</p></div>'
      + '<div class="card"><h3>Delegation</h3><p>' + esc(authorized?.delegationId || run.delegationId || '—') + '</p></div>'
      + '<div class="card"><h3>Tenant</h3><p>' + esc(run.tenantId || '—') + '</p></div>'
    + '</div>'
    + (evidence?.chain ? '<details><summary>Evidence chain</summary><pre>' + esc(JSON.stringify(evidence.chain, null, 2)) + '</pre></details>' : '')
    + (evidence?.resolution ? '<p class="muted">Resolved ' + esc(evidence.resolution.resolvedAt) + ' by ' + esc(evidence.resolution.resolvedBy) + ': ' + esc(evidence.resolution.resolution) + '</p>' : '')
    + (evidence?.providerResult ? '<h2>Provider result</h2><div class="grid">'
        + '<div class="card"><h3>Status</h3><p>' + statusPill(evidence.providerResult.status) + '</p><p class="muted">' + esc(evidence.providerResult.summary) + '</p></div>'
        + '<div class="card"><h3>Provider reference</h3><p>' + esc(evidence.providerResult.providerOperationId || '—') + '</p></div>'
        + '<div class="card"><h3>Observed</h3><p class="muted">' + esc(JSON.stringify(evidence.providerResult.observed)) + '</p></div>'
        + '</div>' : '')
    + (evidence ? '<details><summary>Execution output' + (evidence.execution?.truncated?.stdout || evidence.execution?.truncated?.stderr ? ' (truncated)' : '') + '</summary>'
        + '<p class="muted">stdout</p><pre>' + esc(evidence.stdout || '') + '</pre><p class="muted">stderr</p><pre>' + esc(evidence.stderr || '') + '</pre></details>' : '');
  if (!['completed', 'failed', 'cancelled'].includes(run.status)) setTimeout(() => location.reload(), 5000);
} catch (error) { fail(detail, error); }
`);
}

export function providersPage(): string {
  return productPage('providers', 'Providers', `
<h1>Providers</h1>
<p class="lede">Who performs operational work, what each can do from here, and whether it can do it now. Whether Factory <em>may</em> do it is AuthBoundry's answer, asked per Action.</p>
<div id="providers"><p class="muted">Loading…</p></div>
<h2>Execution engines</h2>
<div id="engines" class="muted"></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#providers');
try {
  const { providers, engines } = await api('/v1/providers');
  target.innerHTML = providers.length ? providers.map((provider) =>
    '<section class="card provider"><h3>' + esc(provider.name) + ' ' + statusPill(provider.status)
    + (provider.configured ? ' <span class="pill">configured</span>' : '') + '</h3>'
    + '<p class="muted">' + esc(provider.detail) + '</p>'
    + (provider.credentials.length ? '<p class="muted">Credentials resolved at execution: ' + provider.credentials.map((name) => esc(name) + ' (' + (provider.credentialsPresent[name] ? 'present' : 'missing') + ')').join(', ') + ' — names only</p>' : '')
    + (provider.vocabulary.length ? '<p class="muted">Not offered by this provider: ' + provider.vocabulary.map(esc).join(', ') + '</p>' : '')
    + '<p><strong>Capabilities</strong></p>'
    + (provider.capabilities.length ? '<ul class="caps">' + provider.capabilities.map((entry) =>
        '<li><details><summary>' + esc(entry.capability) + ' ' + statusPill(entry.executable ? 'executable' : 'not executable')
        + (entry.operation ? ' <span class="muted">via ' + esc(entry.operation) + '</span>' : '') + '</summary>'
        + '<p class="muted">implementation: ' + (entry.implementation ? 'yes' : 'no') + ' · declared: ' + (entry.declared ? 'yes' : 'no')
          + ' · available: ' + (entry.available ? 'yes' : 'no') + ' · credential: ' + (entry.credential ? 'yes' : 'no')
          + ' · configuration: ' + (entry.configuration ? 'yes' : 'no') + ' · executable: ' + (entry.executable ? 'yes' : 'no') + '</p>'
        + (entry.reasons.length ? '<p class="muted">' + entry.reasons.map(esc).join('; ') + '</p>' : '')
        + '<p class="muted">Requires authority: ' + (entry.requiredAuthority.length ? entry.requiredAuthority.map(esc).join(', ') : '—') + '</p>'
        + (entry.verificationRequires ? '<p class="muted">Verified by: ' + esc(entry.verificationRequires) + '</p>' : '')
        + (entry.idempotency ? '<p class="muted">Idempotency: ' + (entry.idempotency.exactlyOnce ? 'exactly-once' : 'not exactly-once') + (entry.idempotency.note ? ' — ' + esc(entry.idempotency.note) : '') + '</p>' : '')
        + (entry.recent.length ? '<p>Recent: ' + entry.recent.map((action) =>
            '<a href="/factory/actions/' + esc(action.id) + '">' + esc(action.id.slice(0, 12)) + '</a> ' + statusPill(action.outcome || action.status)).join(' ') + '</p>' : '<p class="muted">No executions yet.</p>')
        + '</details></li>').join('') + '</ul>'
      : '<p class="muted">None declared in .flow.</p>')
    + (provider.projects.length ? '<p><strong>Projects</strong><br>' + provider.projects.map((project) =>
        '<a href="/factory/projects/' + esc(project.id) + '">' + esc(project.name) + '</a>'
        + (project.environments.length ? ' <span class="muted">(' + project.environments.map(esc).join(', ') + ')</span>' : '')).join('<br>') + '</p>' : '')
    + (provider.recentActions.length ? '<p><strong>Recent Actions</strong></p><table><thead><tr><th>Action</th><th>Capability</th><th>Resource</th><th>Result</th></tr></thead><tbody>'
        + provider.recentActions.map((action) => '<tr><td><a href="/factory/actions/' + esc(action.id) + '">' + esc(action.id.slice(0, 12)) + '</a></td>'
          + '<td>' + esc(action.capability || '—') + '</td><td>' + esc(action.resource || '—') + '</td><td>' + statusPill(action.outcome || action.status) + '</td></tr>').join('')
        + '</tbody></table>' : '')
    + '</section>').join('')
    : '<div class="empty">No providers.</div>';
  document.querySelector('#engines').innerHTML = engines.map((engine) =>
    esc(engine.name) + ' ' + statusPill(engine.connectionState) + ' — ' + esc(engine.connectionDetail)).join('<br>');
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

const GRAPH_NODE_MARK = `
  const mark = (status) => ({ completed: '✓', running: '●', failed: '✗', cancelled: '✗', 'awaiting-approval': '◐', unknown: '?' })[status] || '○';
`;

export function graphsPage(): string {
  return productPage('graphs', 'Operations', `
<h1>Operations</h1>
<p class="lede">Coordinated operational changes: what runs, what waits on what, and what stopped.</p>
<div id="graphs"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#graphs');
try {
  const { graphs } = await api('/v1/action-graphs');
  target.innerHTML = graphs.length
    ? '<table><thead><tr><th>Graph</th><th>Project</th><th>Origin</th><th>Status</th><th>Updated</th></tr></thead><tbody>'
      + graphs.map((graph) =>
        '<tr><td><a href="/factory/graphs/' + esc(graph.id) + '">' + esc(graph.id) + '</a></td>'
        + '<td><a href="/factory/projects/' + esc(graph.projectId) + '">' + esc(graph.projectId) + '</a></td>'
        + '<td class="muted">' + esc(graph.origin?.kind || 'manual')
          + (graph.origin?.sourceSystem ? ' · ' + esc(graph.origin.sourceSystem) + ':' + esc(graph.origin.sourceType || '') + ' ' + esc(graph.origin.sourceId || '') : '') + '</td>'
        + '<td>' + statusPill(graph.status) + '</td><td class="muted">' + esc(graph.updatedAt) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">No operations yet.</div>';
} catch (error) { fail(target, error); }
`);
}

export function graphPage(graphId: string): string {
  return productPage('graphs', 'Operation', `
<h1 id="title">Operational change</h1>
<p class="lede" id="subtitle"></p>
<div id="graph"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
${GRAPH_NODE_MARK}
const graphId = ${scriptLiteral(graphId)};
const target = document.querySelector('#graph');
async function render() {
  try {
    const graph = await api('/v1/action-graphs/' + graphId);
    document.querySelector('#title').innerHTML = 'Operational change ' + statusPill(graph.status);
    document.querySelector('#subtitle').textContent = graph.origin.kind
      + (graph.origin.sourceSystem ? ' · ' + graph.origin.sourceSystem + ':' + (graph.origin.sourceType || '') + ' ' + (graph.origin.sourceId || '') : '')
      + (graph.requestedBy ? ' · requested by ' + graph.requestedBy : '');
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.actionId, node]));
    target.innerHTML = '<div class="nodes">' + graph.nodes.map((node) =>
      '<div class="node ' + esc(node.status) + '"><div class="node-head"><span class="mark">' + mark(node.status) + '</span> '
      + '<a href="/factory/actions/' + esc(node.actionId) + '">' + esc(node.type) + '</a> ' + statusPill(node.status)
      + (node.outcome && node.outcome !== 'succeeded' ? ' ' + statusPill(node.outcome) : '') + '</div>'
      + '<div class="muted">' + esc(node.intent) + '</div>'
      + (node.capability ? '<div class="muted">' + esc(node.provider || '?') + ' · ' + esc(node.capability) + (node.resource ? ' · ' + esc(node.resource) : '') + '</div>' : '')
      + (node.dependsOn.length ? '<div class="muted">after: ' + node.dependsOn.map((id) => esc(byId[id]?.type || id)).join(', ') + '</div>' : '')
      + (node.reason ? '<div class="banner ' + (node.blockedBy.length ? '' : 'drift') + '"><strong>' + (node.blockedBy.length ? 'Blocked by' : 'Blocked') + ':</strong> ' + esc(node.reason) + '</div>' : '')
      + '<div class="muted">authority: ' + esc(node.autonomy ? (node.autonomy.allowed ? 'autonomous' : 'needs a person') : 'not asked')
      + (node.authority?.delegation ? ' · ' + esc(node.authority.delegation) : '') + '</div>'
      + (node.runId ? '<div class="muted">run: <a href="/factory/runs/' + esc(node.runId) + '">' + esc(node.runId) + '</a>'
          + ' · <a href="/v1/runs/' + esc(node.runId) + '/evidence">evidence</a></div>' : '')
      + (node.verification.length ? '<div class="muted">verification: '
          + node.verification.map((check) => esc(check.name) + ' ' + esc(check.status)).join(', ') + '</div>' : '')
      + (node.status === 'failed' ? '<button data-retry="' + esc(node.actionId) + '">Retry</button>' : '')
      + '</div>').join('<div class="arrow">↓</div>') + '</div>'
      + (graph.failure ? '<div class="banner drift"><p><strong>Stopped:</strong> ' + esc(graph.failure.outcome) + '</p><p class="muted">' + esc(graph.failure.reason) + '</p></div>' : '')
      + '<p>' + (['planned','ready','blocked'].includes(graph.status) ? '<button id="run">Coordinate</button> ' : '')
      + (!['completed','cancelled'].includes(graph.status) ? '<button id="cancel">Cancel</button>' : '') + '</p>';
    const run = target.querySelector('#run');
    if (run) run.onclick = async () => { run.disabled = true; try { await api('/v1/action-graphs/' + graphId + '/run', { method: 'POST', body: JSON.stringify({}) }); await render(); } catch (error) { fail(target, error); } };
    const cancel = target.querySelector('#cancel');
    if (cancel) cancel.onclick = async () => { if (!confirm('Cancel this operation?')) return; try { await api('/v1/action-graphs/' + graphId + '/cancel', { method: 'POST', body: JSON.stringify({}) }); await render(); } catch (error) { fail(target, error); } };
    target.querySelectorAll('[data-retry]').forEach((button) => {
      button.onclick = async () => { button.disabled = true; try { await api('/v1/actions/' + button.dataset.retry + '/retry', { method: 'POST', body: JSON.stringify({}) }); await render(); } catch (error) { fail(target, error); } };
    });
  } catch (error) { fail(target, error); }
}
await render();
`);
}

export function workListPage(): string {
  return productPage('work', 'Requested work', `
<h1>Requested work</h1>
<p class="lede">Operational work other systems asked Factory for. The origin says who asked; Factory decides nothing from it and reads nothing behind it.</p>
<div id="work"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
const target = document.querySelector('#work');
try {
  const { work } = await api('/v1/operational-work');
  target.innerHTML = work.length
    ? '<table><thead><tr><th>Work</th><th>Origin</th><th>Intent</th><th>Status</th><th>Outcome</th><th>Updated</th></tr></thead><tbody>'
      + work.map((item) =>
        '<tr><td><a href="/factory/work/' + esc(item.workId) + '">' + esc(item.workId.slice(0, 16)) + '</a></td>'
        + '<td>' + esc(item.origin.system) + ' · ' + esc(item.origin.type) + ' <code>' + esc(item.origin.id) + '</code></td>'
        + '<td class="muted">' + esc(item.intent || '—') + '</td>'
        + '<td>' + statusPill(item.status) + '</td>'
        + '<td>' + (item.outcome ? statusPill(item.outcome) : '<span class="muted">—</span>') + '</td>'
        + '<td class="muted">' + esc(item.updatedAt) + '</td></tr>').join('')
      + '</tbody></table>'
    : '<div class="empty">No work has been requested by another system yet.</div>';
} catch (error) { fail(target, error); }
`);
}

export function workPage(workId: string): string {
  return productPage('work', 'Requested work', `
<h1 id="title">Requested work</h1>
<p class="lede" id="subtitle"></p>
<div id="work"><p class="muted">Loading…</p></div>
<h2>History</h2>
<div id="events"><p class="muted">Loading…</p></div>
`, `
const { api, esc, statusPill, fail } = window.factory;
${GRAPH_NODE_MARK}
const workId = ${scriptLiteral(workId)};
const target = document.querySelector('#work');
const history = document.querySelector('#events');
async function render() {
  try {
    const work = await api('/v1/operational-work/' + workId);
    document.querySelector('#title').innerHTML = 'Requested work ' + statusPill(work.status)
      + (work.outcome ? ' ' + statusPill(work.outcome) : '');
    document.querySelector('#subtitle').textContent = 'Origin: ' + work.origin.system + ' ' + work.origin.type + ' ' + work.origin.id
      + ' · contract ' + work.contract + (work.intent ? ' · ' + work.intent : '');
    target.innerHTML =
      '<div class="banner"><p><strong>Origin</strong> ' + esc(work.origin.system) + ' · ' + esc(work.origin.type) + ' <code>' + esc(work.origin.id) + '</code></p>'
      + '<p class="muted">A reference Factory records, never a source it reads. Whether each step may run was decided by AuthBoundry, not by the request.</p></div>'
      + (work.graphId ? '<p><a href="/factory/graphs/' + esc(work.graphId) + '">Action graph ' + esc(work.graphId) + '</a></p>' : '<p class="muted">Not yet planned.</p>')
      + '<div class="nodes">' + work.actions.map((node) =>
        '<div class="node ' + esc(node.status) + '"><div class="node-head"><span class="mark">' + mark(node.status) + '</span> '
        + '<a href="/factory/actions/' + esc(node.actionId) + '">' + esc(node.key) + '</a> ' + statusPill(node.status)
        + (node.outcome && node.outcome !== 'succeeded' ? ' ' + statusPill(node.outcome) : '')
        + (node.implied ? ' <span class="muted">(added by Factory operational rules)</span>' : '') + '</div>'
        + '<div class="muted">' + esc(node.capability) + (node.provider ? ' · ' + esc(node.provider) : '') + '</div>'
        + (node.runId ? '<div class="muted">run: <a href="/factory/runs/' + esc(node.runId) + '">' + esc(node.runId) + '</a>'
            + (node.evidenceId ? ' · <a href="/v1/runs/' + esc(node.runId) + '/evidence">evidence</a>' : '') + '</div>' : '')
        + '</div>').join('<div class="arrow">↓</div>') + '</div>'
      + '<p>' + (!['completed', 'failed', 'cancelled'].includes(work.status) ? '<button id="cancel">Cancel</button>' : '') + '</p>';
    const cancel = target.querySelector('#cancel');
    if (cancel) cancel.onclick = async () => { if (!confirm('Cancel this work?')) return; try { await api('/v1/operational-work/' + workId + '/cancel', { method: 'POST', body: JSON.stringify({}) }); await render(); } catch (error) { fail(target, error); } };
    const { events } = await api('/v1/operational-work/' + workId + '/events');
    history.innerHTML = events.length
      ? '<table><thead><tr><th>Event</th><th>Status</th><th>Outcome</th><th>When</th></tr></thead><tbody>'
        + events.map((event) => '<tr><td>' + esc(event.type) + '</td><td>' + statusPill(event.status) + '</td>'
          + '<td>' + (event.outcome ? statusPill(event.outcome) : '<span class="muted">—</span>') + '</td>'
          + '<td class="muted">' + esc(event.createdAt) + '</td></tr>').join('') + '</tbody></table>'
      : '<p class="muted">No events yet.</p>';
  } catch (error) { fail(target, error); }
}
await render();
`);
}
