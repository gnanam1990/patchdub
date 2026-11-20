// PatchDub operator console. All actions go through the same API paths as the
// tests; the selected cue lives in the location hash so refresh preserves it.

const state = {
  token: localStorage.getItem('pd.token') || '',
  workspaceId: localStorage.getItem('pd.workspaceId') || '',
  me: null,
  caseData: null,
  selectedPatch: null,
  plan: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) n.append(c);
  return n;
};

function announce(msg) { $('#status').textContent = msg; }

function alertBox(msg, kind = 'error') {
  const box = el('div', { class: `alert ${kind === 'info' ? 'info' : ''}`, role: 'alert', text: msg });
  $('#alerts').append(box);
  setTimeout(() => box.remove(), 9000);
  announce(msg);
}

async function api(method, path, body, ifMatch) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(ifMatch !== undefined ? { 'if-match': String(ifMatch) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    err.detail = data?.error?.detail;
    throw err;
  }
  return data;
}

const fmtMs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const badge = (text) => el('span', { class: `badge ${text}`, text });

// --- routing -----------------------------------------------------------------

function route() {
  const hash = location.hash || '#/';
  const m = /^#\/edition\/([^/]+)(?:\/cue\/([^/]+))?/.exec(hash);
  if (!state.token || !state.workspaceId) return showSignin();
  if (m) return showCase(m[1], m[2]);
  return showEditions();
}

function show(id) {
  for (const s of ['#view-signin', '#view-editions', '#view-case']) {
    $(s).hidden = s !== id;
  }
}

function showSignin() {
  show('#view-signin');
  $('#in-token').focus();
}

async function showEditions() {
  show('#view-editions');
  const { workspace, editions, me } = await api('GET', `/api/workspaces/${state.workspaceId}`);
  state.me = me;
  $('#identity').textContent = `${me.name} (${me.role}) · ${workspace.name}`;
  const list = $('#edition-list');
  list.replaceChildren();
  for (const ed of editions) {
    list.append(el('li', {}, [
      el('a', { href: `#/edition/${ed.id}`, text: ed.title || ed.id }),
      el('span', { class: 'muted', text: ` ${ed.source_locale} → ${ed.target_locale}` }),
    ]));
  }
  announce(`${editions.length} editions`);
}

async function showCase(editionId, patchId) {
  show('#view-case');
  if (!state.me) {
    const { me, workspace } = await api('GET', `/api/workspaces/${state.workspaceId}`);
    state.me = me;
    $('#identity').textContent = `${me.name} (${me.role}) · ${workspace.name}`;
  }
  const data = await api('GET', `/api/editions/${editionId}/case`);
  state.caseData = data;
  state.selectedPatch = patchId || state.selectedPatch;
  $('#case-title').textContent = data.edition.title || editionId;
  renderRevisions(data);
  renderAlignment(data);
  await renderPlan(data);
  renderPatches(data);
  renderExports(data);
  await renderOperator(data);
  if (patchId) {
    const row = document.getElementById(`patch-${patchId}`);
    row?.focus();
  }
}

// --- sections -----------------------------------------------------------------

function renderRevisions(data) {
  const box = $('#revision-list');
  box.replaceChildren();
  const table = el('table', { class: 'grid' });
  table.append(el('thead', {}, el('tr', {}, ['Kind', 'Label', 'SHA-256', 'Imported'].map((t) => el('th', { scope: 'col', text: t })))));
  const tb = el('tbody');
  for (const r of data.revisions) {
    tb.append(el('tr', {}, [
      el('td', { text: r.kind }),
      el('td', { text: r.label }),
      el('td', { class: 'mono', text: r.input_sha256.slice(0, 16) + '…' }),
      el('td', { text: r.imported_at.slice(0, 19) }),
    ]));
  }
  table.append(tb);
  box.append(table);

  const parentSel = $('#in-parent');
  parentSel.replaceChildren(el('option', { value: '', text: '— none —' }));
  for (const r of data.revisions.filter((x) => x.kind === 'source')) {
    parentSel.append(el('option', { value: r.id, text: `${r.label} (${r.id.slice(0, 12)}…)` }));
  }
}

function renderAlignment(data) {
  const tbody = $('#align-table tbody');
  tbody.replaceChildren();
  $('#align-summary').textContent = data.alignment.length
    ? `${data.alignment.length} group(s); ${data.unresolvedGroups} need manual review.`
    : 'No alignment yet — import a replacement source with a parent, then compute.';
  const cueLabel = (c) => c
    ? `${c.cue_id || 'seq ' + (c.seq + 1)} · ${fmtMs(c.start_ms)}–${fmtMs(c.end_ms)}`
    : '—';
  for (const g of data.alignment) {
    const actionCell = el('td');
    if (g.status === 'needs_review') {
      const btn = el('button', { type: 'button', class: 'secondary', text: 'Resolve…' });
      btn.addEventListener('click', () => openResolveDialog(g));
      actionCell.append(btn);
    } else {
      actionCell.append(el('span', { class: 'muted', text: g.status }));
    }
    tbody.append(el('tr', {}, [
      el('td', { text: g.group_key }),
      el('td', { text: (g.old_cues || []).map(cueLabel).join(', ') || '—' }),
      el('td', { text: (g.new_cues || []).map(cueLabel).join(', ') || '—' }),
      el('td', {}, badge(g.kind)),
      el('td', { text: g.reason }),
      actionCell,
    ]));
  }
}

let resolveTarget = null;
function openResolveDialog(group) {
  resolveTarget = group;
  $('#resolve-desc').textContent = `${group.group_key}: ${group.reason}`;
  $('#dlg-resolve').showModal();
}

$('#form-resolve').addEventListener('submit', async (e) => {
  if (e.submitter?.id !== 'btn-resolve-ok') return;
  e.preventDefault();
  const kind = $('#in-resolve-kind').value;
  const reason = $('#in-resolve-reason').value;
  const rev = latestSourceRevision();
  try {
    await api('PUT', `/api/revisions/${rev}/alignment/${resolveTarget.group_key}`,
      { kind, reason, oldCueIds: resolveTarget.old_cue_ids, newCueIds: resolveTarget.new_cue_ids });
    $('#dlg-resolve').close();
    announce(`Group ${resolveTarget.group_key} resolved as ${kind}`);
    route();
  } catch (err) { alertBox(err.message); }
});

function latestSourceRevision() {
  const srcs = state.caseData.revisions.filter((r) => r.kind === 'source');
  return srcs[srcs.length - 1]?.id;
}

async function renderPlan(data) {
  const box = $('#plan-box');
  box.replaceChildren();
  // Populate the glossary picker so a plan can pin a term base.
  try {
    const { glossaries } = await api('GET', `/api/workspaces/${state.workspaceId}/glossaries`);
    const sel = $('#in-glossary');
    const prev = sel.value;
    sel.replaceChildren(el('option', { value: '', text: '— none —' }));
    for (const g of glossaries) {
      sel.append(el('option', { value: g.id, text: `${g.name} (${g.digest.slice(0, 10)}…)` }));
    }
    sel.value = prev;
  } catch { /* glossary list is optional */ }
  const plans = data.plans || [];
  const latest = plans[plans.length - 1];
  if (latest) {
    state.plan = latest;
    box.append(el('p', {}, [
      el('strong', { text: `Plan ${latest.id.slice(0, 14)}… ` }),
      badge(latest.status),
      el('span', { text: ` · total ${latest.total_minor} minor · cap ${latest.cap_minor} minor` }),
    ]));
    $('#quote-box').hidden = false;
    $('#quote-text').textContent =
      `Quote: ${latest.total_minor} minor units against cap ${latest.cap_minor}. ` +
      `Revision ${latest.new_revision_id.slice(0, 14)}…`;
    $('#quote-digest').textContent = `Glossary digest: ${latest.glossary_digest || 'none'} · version ${latest.version}`;
    $('#btn-approve').disabled = latest.status !== 'ready' || data.unresolvedGroups > 0;
  } else {
    $('#quote-box').hidden = true;
    box.append(el('p', { class: 'muted', text: 'No plan yet. Set a cap and create one after alignment.' }));
  }
}

$('#form-plan').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', `/api/revisions/${latestSourceRevision()}/repair-plans`, {
      capMinor: Number($('#in-cap').value),
      glossaryId: $('#in-glossary').value || undefined,
    });
    announce('Plan created');
    route();
  } catch (err) { alertBox(err.message); }
});

$('#btn-approve').addEventListener('click', async () => {
  try {
    const out = await api('POST', `/api/plans/${state.plan.id}/approve`, {
      idempotencyKey: `approve-${state.plan.id}`,
      expectedVersion: state.plan.version,
    });
    announce(`Operation ${out.operationId}: ${out.status}; ${out.dispatched} order(s) dispatched`);
    alertBox(`Operation ${out.operationId}: ${out.status}; ${out.dispatched} order(s) dispatched. ` +
      'The worker continues in the background.', 'info');
    setTimeout(route, 800);
  } catch (err) {
    alertBox(err.detail?.blockers ? `${err.message}: ${err.detail.blockers.join('; ')}` : err.message);
  }
});

function renderPatches(data) {
  const tbody = $('#patch-table tbody');
  tbody.replaceChildren();
  for (const p of data.patches) {
    const tr = el('tr', { id: `patch-${p.id}`, tabindex: '0', 'data-patch': p.id });
    if (p.id === state.selectedPatch) tr.classList.add('selected');
    tr.addEventListener('click', () => selectPatch(p.id));
    tr.addEventListener('focus', () => selectPatch(p.id));

    const openF = p.open_findings;
    const variant = el('textarea', { rows: '2', 'aria-label': `target variant for ${p.group_key}` });
    variant.value = '';
    // Inside the editor: Escape returns to cue navigation, Ctrl/Cmd+S saves.
    variant.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); tr.focus(); }
      else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveVariant(p, variant.value);
      }
      e.stopPropagation();
    });

    const findingsCell = el('td');
    const actions = el('td');
    const canReview = state.me?.role === 'reviewer';
    if (canReview) {
      const save = el('button', { type: 'button', class: 'secondary', text: 'Save (s)' });
      save.addEventListener('click', () => saveVariant(p, variant.value));
      const approve = el('button', { type: 'button', class: 'primary', text: 'Approve (a)' });
      approve.addEventListener('click', () => reviewPatch(p, 'approve', variant.value));
      const reject = el('button', { type: 'button', class: 'secondary', text: 'Reject (x)' });
      reject.addEventListener('click', () => reviewPatch(p, 'reject', variant.value));
      const reason = el('input', { type: 'text', placeholder: 'reason', 'aria-label': 'review reason' });
      actions.append(save, approve, reject, reason);
    } else {
      actions.append(el('span', { class: 'muted', text: 'reviewer only' }));
      variant.readOnly = true;
    }

    tr.append(
      el('td', { text: `${p.cue_label || p.group_key}` }),
      el('td', { text: `${fmtMs(p.start_ms)}–${fmtMs(p.end_ms)}` }),
      el('td', {}, badge(p.change_kind)),
      el('td', { text: p.source_text }),
      el('td', {}, variant),
      findingsCell,
      el('td', {}, badge(p.status)),
      el('td', { text: String(p.price_minor) }),
      actions,
    );
    tbody.append(tr);

    // Hydrate the full patch (variant text + findings) lazily.
    api('GET', `/api/patches/${p.id}`).then((full) => {
      variant.value = full.patch.variant_text || '';
      tr.dataset.version = full.patch.expected_version;
      tr.dataset.digest = full.patch.variant_hash || '';
      const ul = el('ul', { class: 'findings' });
      for (const fnd of full.findings) {
        ul.append(el('li', { class: fnd.status, text: `${fnd.status === 'open' ? '●' : '○'} ${fnd.message}` }));
      }
      findingsCell.replaceChildren(ul);
    }).catch(() => {});
  }
}

function selectPatch(id) {
  state.selectedPatch = id;
  const base = location.hash.split('/cue/')[0];
  history.replaceState(null, '', `${base}/cue/${id}`);
  for (const tr of document.querySelectorAll('#patch-table tr[data-patch]')) {
    tr.classList.toggle('selected', tr.dataset.patch === id);
  }
}

function selectedRow() {
  return document.querySelector(`#patch-table tr[data-patch="${state.selectedPatch}"]`)
    || document.querySelector('#patch-table tr[data-patch]');
}

async function saveVariant(p, text) {
  const tr = document.querySelector(`#patch-table tr[data-patch="${p.id}"]`);
  try {
    const out = await api('PUT', `/api/patches/${p.id}`, { variantText: text }, tr?.dataset.version ?? p.expected_version);
    announce(`Saved; patch version ${out.expected_version}`);
    setTimeout(route, 300);
  } catch (err) { alertBox(`${err.code || 'error'}: ${err.message}`); }
}

async function reviewPatch(p, verdict, text) {
  const tr = document.querySelector(`#patch-table tr[data-patch="${p.id}"]`);
  // Persist the current textarea first if it differs.
  try {
    if (text && tr?.dataset.digest !== undefined) {
      const cur = await api('GET', `/api/patches/${p.id}`);
      if (cur.patch.variant_text !== text) {
        await api('PUT', `/api/patches/${p.id}`, { variantText: text }, cur.patch.expected_version);
      }
    }
    const cur = await api('GET', `/api/patches/${p.id}`);
    const reason = tr?.querySelector('input')?.value || '';
    await api('PUT', `/api/patches/${p.id}/review`,
      { verdict, reason, digest: cur.patch.variant_hash }, cur.patch.expected_version);
    announce(`${verdict === 'approve' ? 'Approved' : 'Rejected'} ${p.group_key}`);
    setTimeout(route, 300);
  } catch (err) { alertBox(`${err.code || 'error'}: ${err.message}`); }
}

// --- exports / operator ---------------------------------------------------------

function renderExports(data) {
  const box = $('#export-box');
  box.replaceChildren();
  const list = $('#export-list');
  list.replaceChildren();
  const finalOk = data.unresolvedGroups === 0;
  box.append(el('p', {
    text: finalOk
      ? 'Alignment resolved. Final export requires zero open findings, all changed patches approved and purchases settled.'
      : `${data.unresolvedGroups} alignment group(s) still need review.`,
  }));
  const isDistributor = state.me?.role === 'distributor';
  $('#btn-draft').hidden = isDistributor;
  $('#btn-final').hidden = isDistributor;
  const ul = el('ul', { class: 'cardlist' });
  for (const x of data.exports.slice().reverse()) {
    if (isDistributor && x.kind !== 'final') continue; // drafts are not for distributors
    const link = el('a', { href: '#', text: `${x.id.slice(0, 14)}…` });
    ul.append(el('li', {}, [
      badge(x.kind), ' ',
      link,
      el('span', { class: 'mono', text: ` ${x.artifact_hash.slice(0, 12)}…` }),
      el('span', { class: 'muted', text: ` ${x.created_at.slice(0, 19)}` }),
    ]));
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        // Authorized download (window.open cannot send the actor token).
        const res = await fetch(`/api/exports/${x.id}/artifact`, {
          headers: { authorization: `Bearer ${state.token}` },
        });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        const blob = await res.blob();
        const a = el('a', { href: URL.createObjectURL(blob), download: `${x.id}.vtt` });
        document.body.append(a);
        a.click();
        a.remove();
        const man = await api('GET', `/api/exports/${x.id}/manifest`);
        alertBox(`Billable: ${man.usage.billableSeconds}s over ${man.usage.paidItems} item(s), ${man.usage.totalMinor} minor units`, 'info');
      } catch (err) { alertBox(err.message); }
    });
  }
  list.append(ul);
}

$('#btn-draft').addEventListener('click', () => doExport('draft'));
$('#btn-final').addEventListener('click', () => doExport('final'));
async function doExport(kind) {
  try {
    const out = await api('POST', `/api/revisions/${latestSourceRevision()}/exports`, { kind });
    announce(`${kind} export ${out.id.slice(0, 14)}… created`);
    route();
  } catch (err) {
    alertBox(err.detail?.blockers ? `${err.message}: ${err.detail.blockers.join('; ')}` : err.message);
  }
}

async function renderOperator(data) {
  const panel = $('#panel-operator');
  if (state.me?.role !== 'operator' && state.me?.role !== 'producer') { panel.hidden = true; return; }
  const q = await api('GET', `/api/operator/queue?workspace_id=${state.workspaceId}`);
  panel.hidden = q.unknownPurchases.length === 0 && q.pendingOutbox.length === 0;
  const box = $('#operator-box');
  box.replaceChildren();
  for (const pu of q.unknownPurchases) {
    const btn = el('button', { type: 'button', text: 'Reconcile' });
    btn.addEventListener('click', async () => {
      const out = await api('POST', `/api/purchases/${pu.id}/reconcile`);
      announce(`Reconcile ${pu.external_ref}: ${out.state}`);
      route();
    });
    box.append(el('p', {}, [
      badge(pu.status), ' ',
      el('span', { class: 'mono', text: pu.external_ref || 'no ref' }),
      el('span', { text: ` · ${pu.quote_minor} minor · ` }),
      btn,
    ]));
  }
  for (const job of q.pendingOutbox) {
    box.append(el('p', { class: 'muted', text: `pending ${job.kind} (attempts ${job.attempts})` }));
  }
}

// --- forms / keyboard ---------------------------------------------------------

$('#form-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  state.token = $('#in-token').value.trim();
  state.workspaceId = $('#in-workspace').value.trim();
  try {
    await api('GET', `/api/workspaces/${state.workspaceId}`);
    localStorage.setItem('pd.token', state.token);
    localStorage.setItem('pd.workspaceId', state.workspaceId);
    location.hash = '#/';
    route();
  } catch (err) { alertBox(`Sign-in failed: ${err.message}`); }
});

$('#form-bootstrap').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = await api('POST', '/api/workspaces', { name: $('#in-wsname').value, producerName: 'producer' });
  $('#bootstrap-out').textContent =
    `workspace: ${out.workspace.id}\nproducer token: ${out.producer.token}\n(store the token; it is shown once)`;
});

$('#form-edition').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('POST', '/api/editions', {
    workspaceId: state.workspaceId, title: $('#in-title').value,
    sourceLocale: 'en', targetLocale: 'ta',
  });
  route();
});

$('#form-import').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('#in-kind').value;
  const parent = $('#in-parent').value || undefined;
  const srcRevs = state.caseData.revisions.filter((r) => r.kind === 'source');
  try {
    await api('POST', `/api/editions/${state.caseData.edition.id}/revisions`, {
      kind,
      label: $('#in-label').value,
      content: $('#in-vtt').value,
      parentId: kind === 'source' ? parent : undefined,
      sourceRevisionId: kind === 'target' ? srcRevs[0]?.id : undefined,
      idempotencyKey: `imp-${Date.now()}-${$('#in-label').value}`,
    });
    announce('Track imported');
    route();
  } catch (err) { alertBox(err.message); }
});

$('#btn-align').addEventListener('click', async () => {
  try {
    await api('POST', `/api/revisions/${latestSourceRevision()}/alignment/recompute`);
    announce('Alignment computed');
    route();
  } catch (err) { alertBox(err.message); }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || $('#view-case').hidden) return;
  const rows = [...document.querySelectorAll('#patch-table tr[data-patch]')];
  const idx = rows.findIndex((r) => r.dataset.patch === state.selectedPatch);
  const patchOf = (row) => state.caseData.patches.find((p) => p.id === row?.dataset.patch);
  switch (e.key) {
    case 'j': {
      const next = rows[Math.min(idx + 1, rows.length - 1)] || rows[0];
      next?.focus(); break;
    }
    case 'k': {
      const prev = rows[Math.max(idx - 1, 0)] || rows[0];
      prev?.focus(); break;
    }
    case 'e': {
      selectedRow()?.querySelector('textarea')?.focus(); break;
    }
    case 's': {
      const row = selectedRow();
      const p = patchOf(row);
      if (p) saveVariant(p, row.querySelector('textarea').value);
      break;
    }
    case 'a': case 'x': {
      const row = selectedRow();
      const p = patchOf(row);
      if (p) reviewPatch(p, e.key === 'a' ? 'approve' : 'reject', row.querySelector('textarea').value);
      break;
    }
    case '?': {
      alertBox('Keys: j/k move between cues, e edit variant, s save, a approve, x reject; Esc leaves the editor', 'info');
      break;
    }
  }
});

window.addEventListener('hashchange', route);
route();
