/**
 * LunchMoney Importer — Renderer / UI Logic  v1.1
 */

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  apiKey:       localStorage.getItem('lm_api_key') || '',
  queue:        [],     // { id, name, path, status, parsed, assetId, assetName }
  lmAssets:     [],
  lmPayees:     [],
  lmCategories: [],
  prefs:        JSON.parse(localStorage.getItem('lm_prefs') || '{}'),
  validateRows:  [],    // enriched, editable transaction rows
  taxReport:     null,
};

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  setupDropZone();
  setupImportButtons();
  setupSettings();
  setupTaxView();
  setupAccountModal();
  setupValidateModal();

  if (state.apiKey) {
    document.getElementById('api-key-input').value = state.apiKey;
    await connectAPI(state.apiKey, false);
  }
  restorePrefs();
  refreshTracker();
  refreshHistory();
});

// ─── Navigation ───────────────────────────────────────────────────────────────

const PAGE_TITLES = {
  import: 'Import Statements', tracker: 'Coverage Tracker',
  history: 'Upload History',   tax: 'S04 Tax Return', settings: 'Settings',
};

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      item.classList.add('active');
      document.getElementById(`${view}-view`).classList.add('active');
      document.getElementById('page-title').textContent = PAGE_TITLES[view];
      if (view === 'tracker') refreshTracker();
      if (view === 'history') refreshHistory();
    });
  });
}

// ─── API Connection ───────────────────────────────────────────────────────────

async function connectAPI(apiKey, showFeedback = true) {
  const dot   = document.getElementById('api-dot');
  const label = document.getElementById('api-label');
  try {
    const [assetsRes, payeesRes, catsRes] = await Promise.all([
      window.electronAPI.getLMAssets(apiKey),
      window.electronAPI.getLMPayees(apiKey),
      window.electronAPI.getLMCategories(apiKey),
    ]);
    if (!assetsRes.success) throw new Error(assetsRes.error);

    state.lmAssets     = assetsRes.data || [];
    state.lmPayees     = payeesRes.data || [];
    state.lmCategories = catsRes.data   || [];
    state.apiKey       = apiKey;

    dot.className     = 'status-dot connected';
    label.textContent = `Connected · ${state.lmAssets.length} accounts`;

    if (showFeedback) {
      document.getElementById('settings-success').style.display = 'block';
      toast('Connected to LunchMoney!', 'success');
    }
    return true;
  } catch (err) {
    dot.className     = 'status-dot error';
    label.textContent = 'Connection failed';
    if (showFeedback) toast(`API Error: ${err.message}`, 'error');
    return false;
  }
}

// ─── Drop Zone ────────────────────────────────────────────────────────────────

function setupDropZone() {
  const zone      = document.getElementById('drop-zone');
  const browseBtn = document.getElementById('browse-btn');

  zone.addEventListener('dragover',  e  => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop',      e  => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addFilesToQueue([...e.dataTransfer.files].map(f => ({ name: f.name, path: f.path })));
  });
  browseBtn.addEventListener('click', async () => {
    const paths = await window.electronAPI.openFileDialog();
    if (paths.length) addFilesToQueue(paths.map(p => ({ name: p.split(/[\/\\]/).pop(), path: p })));
  });
}

// ─── File Queue ───────────────────────────────────────────────────────────────

function addFilesToQueue(files) {
  for (const f of files) {
    state.queue.push({
      id: Date.now() + Math.random(), name: f.name, path: f.path,
      status: 'pending', parsed: null, assetId: null, assetName: null,
    });
  }
  renderQueue();
  document.getElementById('mapping-section').style.display = state.queue.length ? 'block' : 'none';
}

function renderQueue() {
  const container = document.getElementById('file-queue');
  container.innerHTML = '';

  if (!state.queue.length) {
    document.getElementById('mapping-section').style.display = 'none';
    return;
  }

  for (const item of state.queue) {
    const icon        = item.name.toLowerCase().endsWith('.pdf') ? '📄' : '📊';
    const statusLabel = {
      pending:  'Pending',
      parsing:  'Parsing…',
      ready:    `Ready · ${item.parsed?.transactions?.length || 0} txns`,
      error:    'Error',
      uploaded: 'Uploaded',
    }[item.status] || item.status;
    const pct = { ready: 100, uploaded: 100, parsing: 50 }[item.status] || 0;

    const el  = document.createElement('div');
    el.className  = 'file-item';
    el.dataset.id = item.id;
    el.innerHTML  = `
      <div class="file-icon">${icon}</div>
      <div class="file-info">
        <div class="file-name">${escHtml(item.name)}</div>
        <div class="file-meta">${item.parsed
          ? `${item.parsed.institution} · ${item.parsed.accountName} · ${item.parsed.currency} · ${item.parsed.period?.start || '?'} → ${item.parsed.period?.end || '?'}`
          : item.path}</div>
      </div>
      ${item.assetName ? `<span class="badge badge-blue">→ ${escHtml(item.assetName)}</span>` : ''}
      <span class="file-status ${item.status}">${statusLabel}</span>
      <span class="file-remove" title="Remove" onclick="removeFromQueue('${item.id}')">✕</span>
      <div class="progress-bar" style="width:${pct}%"></div>
    `;
    container.appendChild(el);
  }
}

function removeFromQueue(id) {
  state.queue = state.queue.filter(q => String(q.id) !== String(id));
  renderQueue();
  updateImportButtons();
}

// ─── Import Buttons ───────────────────────────────────────────────────────────

function setupImportButtons() {
  document.getElementById('parse-all-btn').addEventListener('click',  parseAll);
  document.getElementById('validate-btn').addEventListener('click',   openAccountModal);
  document.getElementById('export-csv-btn').addEventListener('click', exportCSV);
  document.getElementById('clear-queue-btn').addEventListener('click', () => {
    state.queue = [];
    renderQueue();
    updateImportButtons();
  });
}

function updateImportButtons() {
  const readyCount = state.queue.filter(q => q.status === 'ready').length;
  document.getElementById('validate-btn').disabled   = readyCount === 0;
  document.getElementById('export-csv-btn').disabled = readyCount === 0;
}

// ─── Parse All ────────────────────────────────────────────────────────────────

async function parseAll() {
  const pending = state.queue.filter(q => q.status === 'pending');
  if (!pending.length) { toast('No pending files to parse', 'info'); return; }

  const btn     = document.getElementById('parse-all-btn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Parsing…';

  for (const item of pending) {
    item.status = 'parsing';
    renderQueue();
    const result = await window.electronAPI.parsePDF(item.path);
    if (result.success) { item.parsed = result.data; item.status = 'ready'; }
    else               { item.status = 'error'; toast(`Failed to parse ${item.name}: ${result.error}`, 'error'); }
    renderQueue();
  }

  btn.disabled  = false;
  btn.innerHTML = '⚡ Parse All';
  updateImportButtons();

  const readyCount = state.queue.filter(q => q.status === 'ready').length;
  if (readyCount > 0) toast(`${readyCount} statement(s) parsed — click "Review & Validate"`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACCOUNT SELECTION MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function setupAccountModal() {
  document.getElementById('account-modal-cancel').addEventListener('click',  closeAccountModal);
  document.getElementById('account-modal-confirm').addEventListener('click', confirmAccountModal);
  document.getElementById('cancel-create-btn').addEventListener('click',     hideCreateForm);
  document.getElementById('create-account-btn').addEventListener('click',    createNewAccount);
}

function openAccountModal() {
  const readyItems = state.queue.filter(q => q.status === 'ready');
  if (!readyItems.length) return;

  const rows = document.getElementById('account-modal-rows');
  rows.innerHTML = '';

  const assetOptions = state.lmAssets.map(a =>
    `<option value="${a.id}">${escHtml(a.display_name || a.name)} (${(a.currency || '').toUpperCase()})</option>`
  ).join('');

  for (const item of readyItems) {
    const suggestion = autoSuggestAsset(item.parsed);

    const row        = document.createElement('div');
    row.className    = 'account-modal-row';
    row.innerHTML    = `
      <div class="account-modal-info">
        <div class="account-modal-label">
          <strong>${escHtml(item.parsed.institution)}</strong> — ${escHtml(item.parsed.accountName)}
          <span class="badge badge-yellow" style="margin-left:6px;">${item.parsed.currency}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);">
          ${item.parsed.transactions?.length || 0} transactions · ${item.parsed.period?.start || '?'} → ${item.parsed.period?.end || '?'}
        </div>
      </div>
      <div style="flex:1;min-width:0;">
        <select class="account-select" data-id="${item.id}" style="width:100%;">
          <option value="">-- Select account --</option>
          ${assetOptions}
          <option value="__create__">➕ Create new account in LunchMoney…</option>
        </select>
      </div>
    `;

    const sel = row.querySelector('.account-select');
    if (suggestion) sel.value = String(suggestion.id);

    sel.addEventListener('change', e => {
      if (e.target.value === '__create__') {
        document.getElementById('new-account-name').value        = item.parsed.accountName || '';
        document.getElementById('new-account-institution').value = item.parsed.institution  || '';
        document.getElementById('new-account-currency').value    = item.parsed.currency      || 'JMD';
        const typeMap = { chequing:'depository', savings:'depository', credit_card:'credit', loan:'loan', investment:'brokerage' };
        document.getElementById('new-account-type').value = typeMap[item.parsed.accountType] || 'depository';
        document.getElementById('create-account-form').style.display     = 'block';
        document.getElementById('create-account-form').dataset.forId     = item.id;
        document.getElementById('create-account-error').style.display    = 'none';
        e.target.value = '';
      }
    });

    rows.appendChild(row);
  }

  document.getElementById('account-modal').classList.add('open');
}

function autoSuggestAsset(parsed) {
  if (!parsed || !state.lmAssets.length) return null;
  const inst = (parsed.institution || '').toLowerCase();
  return state.lmAssets.find(a => {
    const n = ((a.display_name || a.name || '') + ' ' + (a.institution_name || '')).toLowerCase();
    return n.includes(inst) || inst.includes((a.name || '').toLowerCase().split(' ')[0]);
  }) || null;
}

async function createNewAccount() {
  const name        = document.getElementById('new-account-name').value.trim();
  const institution = document.getElementById('new-account-institution').value.trim();
  const typeName    = document.getElementById('new-account-type').value;
  const currency    = document.getElementById('new-account-currency').value;
  const balance     = parseFloat(document.getElementById('new-account-balance').value) || 0;
  const errEl       = document.getElementById('create-account-error');

  if (!name) { errEl.textContent = 'Account name is required.'; errEl.style.display = 'block'; return; }
  if (!state.apiKey) { errEl.textContent = 'No API key. Connect in Settings first.'; errEl.style.display = 'block'; return; }

  const btn     = document.getElementById('create-account-btn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  const result = await window.electronAPI.createLMAsset(state.apiKey, { name, typeName, currency, institutionName: institution, balance });

  btn.disabled  = false;
  btn.innerHTML = 'Create in LunchMoney';

  if (!result.success) {
    errEl.textContent   = `Error: ${result.error}`;
    errEl.style.display = 'block';
    return;
  }

  const newAsset = result.data;
  state.lmAssets.push(newAsset);
  toast(`✓ Created account "${name}" in LunchMoney`, 'success');

  const forId = document.getElementById('create-account-form').dataset.forId;
  const selEl = document.querySelector(`.account-select[data-id="${forId}"]`);
  if (selEl) {
    const opt       = document.createElement('option');
    opt.value       = newAsset.id;
    opt.textContent = `${name} (${currency.toUpperCase()})`;
    selEl.insertBefore(opt, selEl.lastElementChild);
    selEl.value     = String(newAsset.id);
  }

  hideCreateForm();
  errEl.style.display = 'none';
}

function hideCreateForm() {
  document.getElementById('create-account-form').style.display = 'none';
}

function closeAccountModal() {
  document.getElementById('account-modal').classList.remove('open');
}

async function confirmAccountModal() {
  document.querySelectorAll('.account-select').forEach(sel => {
    const item = state.queue.find(q => String(q.id) === sel.dataset.id);
    if (!item) return;
    const assetId    = sel.value && sel.value !== '__create__' ? parseInt(sel.value) : null;
    item.assetId     = assetId;
    const asset      = state.lmAssets.find(a => a.id === assetId);
    item.assetName   = asset ? (asset.display_name || asset.name) : null;
  });

  renderQueue();
  closeAccountModal();
  await openValidateModal();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TRANSACTION VALIDATION MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function setupValidateModal() {
  document.getElementById('validate-modal-cancel').addEventListener('click', () => {
    document.getElementById('validate-modal').classList.remove('open');
  });
  document.getElementById('validate-upload-btn').addEventListener('click', uploadValidated);
  document.getElementById('val-select-all').addEventListener('click',    () => setAllChecked(true));
  document.getElementById('val-deselect-all').addEventListener('click',  () => setAllChecked(false));
  document.getElementById('val-credits-only').addEventListener('click',  () => filterRows('credit'));
  document.getElementById('val-debits-only').addEventListener('click',   () => filterRows('debit'));
  document.getElementById('val-check-all').addEventListener('change',    e  => setAllChecked(e.target.checked));
  document.getElementById('val-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#validate-tbody tr').forEach(tr => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
    updateSelectedCount();
  });
}

async function openValidateModal() {
  toast('Running payee matching…', 'info', 2000);

  const readyItems = state.queue.filter(q => q.status === 'ready' && q.parsed?.transactions?.length);
  let allTxs = [];
  for (const item of readyItems) {
    for (const tx of item.parsed.transactions) {
      allTxs.push({ ...tx, _sourceFile: item.name, _assetId: item.assetId, _assetName: item.assetName });
    }
  }

  if (allTxs.length) {
    const result = await window.electronAPI.processPayees({ transactions: allTxs, existingPayees: state.lmPayees });
    if (result.success) allTxs = result.data;
  }

  state.validateRows = allTxs.map((tx, idx) => ({
    _idx:       idx,
    _include:   true,
    _assetId:   tx._assetId,
    _assetName: tx._assetName,
    _source:    tx._sourceFile,
    _matched:   tx._matched || false,
    date:       tx.date       || '',
    payee:      tx.payee      || '',
    amount:     tx.amount     != null ? tx.amount : 0,
    currency:   tx.currency   || 'JMD',
    notes:      tx.notes      || '',
    category:   tx.category   || '',
    categoryId: tx.categoryId || null,
  }));

  renderValidateTable(state.validateRows);
  document.getElementById('validate-modal').classList.add('open');
}

function renderValidateTable(rows) {
  const tbody = document.getElementById('validate-tbody');
  tbody.innerHTML = '';

  const catOptions = state.lmCategories.map(c =>
    `<option value="${c.id}">${escHtml(c.name)}</option>`
  ).join('');

  rows.forEach((row, i) => {
    const tr    = document.createElement('tr');
    tr.dataset.idx = i;
    tr.innerHTML   = `
      <td style="text-align:center;">
        <input type="checkbox" class="val-row-check" data-idx="${i}" ${row._include ? 'checked' : ''} />
      </td>
      <td>
        <input class="val-cell" data-idx="${i}" data-field="date" value="${escAttr(row.date)}" style="width:96px;" />
      </td>
      <td>
        <input class="val-cell val-payee" data-idx="${i}" data-field="payee"
               value="${escAttr(row.payee)}" style="width:100%;min-width:140px;" />
        ${row._matched ? '<span title="Matched existing LM payee" style="font-size:10px;color:var(--accent2);margin-left:3px;">✓matched</span>' : ''}
      </td>
      <td class="${row.amount >= 0 ? 'amount-pos' : 'amount-neg'}" style="text-align:right;">
        <input class="val-cell" data-idx="${i}" data-field="amount" type="number"
               step="0.01" value="${row.amount}" style="width:90px;text-align:right;" />
      </td>
      <td style="font-size:11px;color:var(--text-muted);">${escHtml(row.currency)}</td>
      <td>
        <input class="val-cell" data-idx="${i}" data-field="notes"
               value="${escAttr(row.notes)}" style="width:100%;min-width:160px;" />
      </td>
      <td>
        <select class="val-cell val-cat" data-idx="${i}" data-field="categoryId" style="width:100%;min-width:120px;">
          <option value="">Uncategorized</option>
          ${catOptions}
        </select>
      </td>
      <td style="font-size:10px;color:var(--text-muted);white-space:nowrap;">
        ${row._assetName ? `<span class="badge badge-blue" style="font-size:10px;">${escHtml(row._assetName)}</span>` : '<span style="color:var(--border);">No account</span>'}
      </td>
    `;

    const catSel = tr.querySelector('.val-cat');
    if (row.categoryId) catSel.value = String(row.categoryId);

    tbody.appendChild(tr);
  });

  // Live-edit listeners
  tbody.querySelectorAll('.val-cell').forEach(el => {
    el.addEventListener('change', e => {
      const idx   = parseInt(e.target.dataset.idx);
      const field = e.target.dataset.field;
      state.validateRows[idx][field] = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
    });
  });

  tbody.querySelectorAll('.val-row-check').forEach(cb => {
    cb.addEventListener('change', e => {
      state.validateRows[parseInt(e.target.dataset.idx)]._include = e.target.checked;
      updateSelectedCount();
    });
  });

  const total   = rows.length;
  const credits = rows.filter(r => r.amount < 0).length;
  const debits  = rows.filter(r => r.amount >= 0).length;
  document.getElementById('validate-counts').textContent =
    `${total} total · ${credits} credits · ${debits} debits`;
  updateSelectedCount();
}

function updateSelectedCount() {
  const visible = [...document.querySelectorAll('#validate-tbody tr')].filter(tr => tr.style.display !== 'none');
  const checked = visible.filter(tr => tr.querySelector('.val-row-check')?.checked).length;
  document.getElementById('val-selected-count').textContent =
    `${checked} of ${state.validateRows.length} selected`;
}

function setAllChecked(checked) {
  state.validateRows.forEach(r => r._include = checked);
  document.querySelectorAll('.val-row-check').forEach(cb => cb.checked = checked);
  document.getElementById('val-check-all').checked = checked;
  updateSelectedCount();
}

function filterRows(type) {
  state.validateRows.forEach((row, i) => {
    const tr = document.querySelector(`#validate-tbody tr[data-idx="${i}"]`);
    if (!tr) return;
    if (type === 'credit')  tr.style.display = row.amount <  0 ? '' : 'none';
    else if (type === 'debit') tr.style.display = row.amount >= 0 ? '' : 'none';
    else tr.style.display = '';
  });
  updateSelectedCount();
}

// ─── Upload validated ─────────────────────────────────────────────────────────

async function uploadValidated() {
  if (!state.apiKey) { toast('Set your LunchMoney API key in Settings first.', 'error'); return; }

  const selected = state.validateRows.filter(r => r._include);
  if (!selected.length) { toast('No transactions selected.', 'info'); return; }

  const btn     = document.getElementById('validate-upload-btn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Uploading…';

  // Group by assetId
  const byAsset = {};
  for (const row of selected) {
    const key = row._assetId || '__none__';
    if (!byAsset[key]) byAsset[key] = { assetId: row._assetId, assetName: row._assetName, rows: [] };
    byAsset[key].rows.push(row);
  }

  const prefs    = getPrefs();
  let totalUp    = 0;
  const allErrors = [];

  for (const group of Object.values(byAsset)) {
    const txs = group.rows.map(r => ({
      date:       r.date,
      payee:      r.payee,
      amount:     r.amount,
      currency:   r.currency,
      notes:      r.notes,
      categoryId: r.categoryId || null,
    }));

    const result = await window.electronAPI.uploadTransactions({
      transactions:   txs,
      apiKey:         state.apiKey,
      assetId:        group.assetId || null,
      skipDuplicates: prefs.skipDuplicates,
      applyRules:     prefs.applyRules,
    });

    if (result.success && result.data) {
      totalUp += result.data.uploaded || 0;

      // Persist to local tracker per source file
      const sources = [...new Set(group.rows.map(r => r._source))];
      for (const filename of sources) {
        const qItem = state.queue.find(q => q.name === filename);
        if (!qItem?.parsed) continue;
        await window.electronAPI.saveUpload({
          institution: qItem.parsed.institution,
          accountName: qItem.parsed.accountName,
          accountType: qItem.parsed.accountType,
          currency:    qItem.parsed.currency,
          lmAssetId:   group.assetId || null,
          filename,
          period:      qItem.parsed.period,
          txCount:     group.rows.filter(r => r._source === filename).length,
          lmIds:       result.data.ids,
          status:      'uploaded',
        });
        qItem.status = 'uploaded';
      }
    } else {
      const msg = result.error || (result.data?.errors || []).join(', ') || 'Unknown error';
      allErrors.push(msg);
    }
  }

  btn.disabled  = false;
  btn.innerHTML = '☁️ Upload Selected to LunchMoney';

  if (totalUp > 0) {
    toast(`✓ Uploaded ${totalUp} transactions to LunchMoney!`, 'success');
    document.getElementById('validate-modal').classList.remove('open');
    renderQueue();
    refreshHistory();
    refreshTracker();
  }
  if (allErrors.length) toast(`Errors: ${allErrors.join('; ')}`, 'error', 8000);
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

async function exportCSV() {
  const txs = state.queue
    .filter(q => q.parsed?.transactions?.length)
    .flatMap(q => q.parsed.transactions);
  if (!txs.length) { toast('No transactions to export.', 'info'); return; }
  const result = await window.electronAPI.exportCSV({ transactions: txs, filename: `lunchmoney-${today()}.csv` });
  if (result.success) toast(`CSV exported to ${result.filePath}`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COVERAGE TRACKER — live from LunchMoney, handles overlapping months
// ═══════════════════════════════════════════════════════════════════════════════

async function refreshTracker() {
  const yearSel     = document.getElementById('tracker-year');
  const year        = parseInt(yearSel ? yearSel.value : new Date().getFullYear());
  const container   = document.getElementById('tracker-accounts');
  const statsEl     = document.getElementById('tracker-stats');
  const refreshBtn  = document.getElementById('tracker-refresh-btn');
  if (refreshBtn) refreshBtn.disabled = true;

  const uploads = await window.electronAPI.getUploads();
  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-label">LunchMoney Accounts</div><div class="stat-value">${state.lmAssets.length}</div></div>
    <div class="stat-card"><div class="stat-label">Total Uploads</div><div class="stat-value">${uploads.length}</div><div class="stat-sub">${uploads.reduce((s,u) => s+(u.tx_count||0),0)} transactions</div></div>
  `;

  if (!state.lmAssets.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>Connect to LunchMoney in Settings to see account coverage.</p></div>';
    if (refreshBtn) refreshBtn.disabled = false;
    return;
  }

  container.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:16px;">
    <span class="spinner"></span> Fetching ${year} coverage from LunchMoney…</div>`;

  const now    = new Date();
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const cards  = [];

  for (const asset of state.lmAssets) {
    let monthData = Array.from({ length: 12 }, (_, i) => ({ month: i+1, year, hasTxns: false, count: 0, earliestDate: null, latestDate: null }));

    if (state.apiKey) {
      const cov = await window.electronAPI.getAssetCoverage({ apiKey: state.apiKey, assetId: asset.id, year });
      if (cov.success) monthData = cov.data;
    }

    const cells = monthData.map((m, idx) => {
      const isFuture = new Date(year, idx, 1) > now;
      const cls   = isFuture ? 'future' : m.hasTxns ? 'covered' : 'missing';
      const title = isFuture
        ? `${MONTHS[idx]} ${year} — future`
        : m.hasTxns
          ? `${MONTHS[idx]} ${year} — ${m.count} transaction${m.count !== 1 ? 's' : ''} · ${m.earliestDate} → ${m.latestDate}`
          : `${MONTHS[idx]} ${year} — no transactions found`;
      const countLabel = m.hasTxns ? `<span style="font-size:9px;color:var(--accent2);">${m.count}</span>` : '';
      return `<div class="month-cell ${cls}" title="${title}">${MONTHS[idx]}${countLabel}</div>`;
    }).join('');

    const missingIdxs  = monthData.reduce((acc, m, i) => (!m.hasTxns && new Date(year, i, 1) <= now ? [...acc, i] : acc), []);
    const coveredCount = monthData.filter(m => m.hasTxns).length;
    const maxMonth     = now.getFullYear() === year ? now.getMonth() + 1 : 12;

    const card   = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;gap:8px;">
        <div style="min-width:0;">
          <div style="font-weight:600;">${escHtml(asset.display_name || asset.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);">
            ${escHtml(asset.institution_name || '')}
            · ${(asset.currency || '').toUpperCase()}
            · Balance: ${fmtAmount(asset.balance)} ${(asset.currency||'').toUpperCase()}
          </div>
        </div>
        ${missingIdxs.length > 0
          ? `<span class="badge badge-red" style="flex-shrink:0;">⚠ ${missingIdxs.length} month${missingIdxs.length!==1?'s':''} missing</span>`
          : `<span class="badge badge-green" style="flex-shrink:0;">✓ ${coveredCount}/${maxMonth} months</span>`}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
        ${year} coverage · Live from LunchMoney · Overlapping periods handled per transaction date
      </div>
      <div class="coverage-grid">${cells}</div>
      ${missingIdxs.length > 0
        ? `<div style="margin-top:8px;font-size:12px;color:var(--warn);">
             Missing: ${missingIdxs.slice(0,6).map(i => `${MONTHS[i]} ${year}`).join(', ')}${missingIdxs.length>6?' + '+( missingIdxs.length-6)+' more':''}
           </div>`
        : ''}
    `;
    cards.push(card);
  }

  container.innerHTML = '';
  cards.forEach(c => container.appendChild(c));
  if (refreshBtn) refreshBtn.disabled = false;
}

// Hook year selector + refresh button
document.addEventListener('DOMContentLoaded', () => {
  const ys = document.getElementById('tracker-year');
  const rb = document.getElementById('tracker-refresh-btn');
  if (ys) ys.addEventListener('change', refreshTracker);
  if (rb) rb.addEventListener('click',  refreshTracker);
});

// ─── History ──────────────────────────────────────────────────────────────────

async function refreshHistory() {
  const uploads = await window.electronAPI.getUploads();
  const tbody   = document.getElementById('history-tbody');
  if (!uploads.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px;">No uploads yet</td></tr>';
    return;
  }
  tbody.innerHTML = uploads.map(u => `
    <tr>
      <td style="color:var(--text-muted);font-size:12px;">${u.uploaded_at?u.uploaded_at.slice(0,16).replace('T',' '):'—'}</td>
      <td>${escHtml(u.institution||'')}</td>
      <td>${escHtml(u.account_name||'')}</td>
      <td style="font-size:12px;">${u.period_start?u.period_start.slice(0,7):'—'} ${u.period_end&&u.period_end!==u.period_start?'→ '+u.period_end.slice(0,7):''}</td>
      <td>${u.tx_count||0}</td>
      <td><span class="badge ${u.status==='uploaded'?'badge-green':'badge-yellow'}">${u.status||'unknown'}</span></td>
    </tr>
  `).join('');
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function setupSettings() {
  document.getElementById('save-api-key-btn').addEventListener('click', async () => {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) { toast('Please enter an API key', 'error'); return; }
    localStorage.setItem('lm_api_key', key);
    await connectAPI(key, true);
  });
  document.getElementById('test-api-btn').addEventListener('click', async () => {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) { toast('Enter an API key first', 'error'); return; }
    await connectAPI(key, true);
  });
  document.getElementById('save-prefs-btn').addEventListener('click', savePrefs);
}

function getPrefs() {
  return {
    defaultCurrency: document.getElementById('default-currency')?.value || 'JMD',
    skipDuplicates:  document.getElementById('skip-duplicates')?.checked  ?? true,
    applyRules:      document.getElementById('apply-rules')?.checked      ?? true,
  };
}
function savePrefs() {
  const prefs = getPrefs();
  localStorage.setItem('lm_prefs', JSON.stringify(prefs));
  state.prefs = prefs;
  toast('Preferences saved', 'success');
}
function restorePrefs() {
  const p = state.prefs;
  if (p.defaultCurrency) document.getElementById('default-currency').value = p.defaultCurrency;
  if (p.skipDuplicates != null) document.getElementById('skip-duplicates').checked = p.skipDuplicates;
  if (p.applyRules      != null) document.getElementById('apply-rules').checked     = p.applyRules;
}

// ─── S04 Tax ──────────────────────────────────────────────────────────────────

function setupTaxView() {
  document.getElementById('generate-tax-btn').addEventListener('click', generateTax);
}

async function generateTax() {
  const year = parseInt(document.getElementById('tax-year-select').value);
  const btn  = document.getElementById('generate-tax-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  const manualData = {
    businessIncome:     parseFloat(document.getElementById('tax-business').value)    || 0,
    foreignIncome:      parseFloat(document.getElementById('tax-foreign').value)     || 0,
    rentalIncome:       parseFloat(document.getElementById('tax-rental').value)      || 0,
    investmentIncome:   parseFloat(document.getElementById('tax-investment').value)  || 0,
    additionalExpenses: parseFloat(document.getElementById('tax-expenses').value)    || 0,
  };

  const result = await window.electronAPI.generateS04({ year, apiKey: state.apiKey || null, manualData });
  btn.disabled  = false;
  btn.innerHTML = '📊 Generate S04 Report';
  if (!result.success) { toast(`Tax generation failed: ${result.error}`, 'error'); return; }
  state.taxReport = result.data;
  renderTaxReport(result.data);
}

function renderTaxReport(report) {
  const wrap = document.getElementById('tax-report-wrap');
  wrap.style.display = 'block';
  const fmt = v => `$${Number(v||0).toLocaleString('en-JM',{minimumFractionDigits:2})}`;
  const bars = buildBarChart(report.monthlyBreakdown || []);

  wrap.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <div style="font-size:18px;font-weight:700;">S04 — Self Employed Income Tax Return</div>
          <div style="font-size:13px;color:var(--text-muted);">Tax Year: ${report.year}</div>
        </div>
        <span class="badge badge-blue">ESTIMATE ONLY</span>
      </div>
      <div class="grid-3" style="margin-bottom:24px;">
        <div class="stat-card"><div class="stat-label">Gross Income</div><div class="stat-value" style="font-size:18px;">${fmt(report.summary.grossIncome)}</div><div class="stat-sub">JMD</div></div>
        <div class="stat-card"><div class="stat-label">Total Tax Payable</div><div class="stat-value" style="font-size:18px;color:var(--warn);">${fmt(report.summary.totalTaxPayable)}</div><div class="stat-sub">Rate: ${report.tax.effectiveRate}</div></div>
        <div class="stat-card"><div class="stat-label">Net After Tax</div><div class="stat-value" style="font-size:18px;color:var(--accent2);">${fmt(report.summary.netIncomeAfterTax)}</div><div class="stat-sub">JMD</div></div>
      </div>
      <div class="tax-section"><div class="card-title">Part A — Income</div>
        <div class="tax-row"><span>Business / Professional</span><span class="tax-amount">${fmt(report.income.businessProfessionalIncome)}</span></div>
        <div class="tax-row"><span>Foreign-Sourced</span><span class="tax-amount">${fmt(report.income.foreignSourcedIncome)}</span></div>
        <div class="tax-row"><span>Investment (Dividends, Interest)</span><span class="tax-amount">${fmt(report.income.investmentIncome)}</span></div>
        <div class="tax-row"><span>Rental</span><span class="tax-amount">${fmt(report.income.rentalIncome)}</span></div>
        <div class="tax-row tax-row-total"><strong>Gross Income</strong><span class="tax-amount highlight">${fmt(report.income.grossIncome)}</span></div>
      </div>
      <div class="tax-section"><div class="card-title">Part B — Deductions</div>
        <div class="tax-row"><span>Allowable Expenses (${report.deductions.methodUsed})</span><span class="tax-amount">− ${fmt(report.deductions.allowableBusinessExpenses)}</span></div>
        <div class="tax-row tax-row-total"><strong>Statutory Income</strong><span class="tax-amount highlight">${fmt(report.statutoryIncome)}</span></div>
      </div>
      <div class="tax-section"><div class="card-title">Part C — Contributions</div>
        <div class="tax-row"><span>NIS (3%)</span><span class="tax-amount">${fmt(report.contributions.nis)}</span></div>
        <div class="tax-row"><span>NHT (2%)</span><span class="tax-amount">${fmt(report.contributions.nht)}</span></div>
        <div class="tax-row"><span>Education Tax (2.25%)</span><span class="tax-amount">${fmt(report.contributions.educationTax)}</span></div>
      </div>
      <div class="tax-section"><div class="card-title">Part D — Income Tax</div>
        <div class="tax-row"><span>Chargeable Income</span><span class="tax-amount">${fmt(report.chargeableIncome)}</span></div>
        <div class="tax-row"><span>Income Tax (25%/30%)</span><span class="tax-amount">${fmt(report.tax.incomeTax)}</span></div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:16px;margin:16px 0;">
        <div class="tax-row" style="border:none;font-size:16px;font-weight:700;">
          <span>Total Tax Payable</span>
          <span style="color:var(--warn);font-size:20px;">${fmt(report.totalTaxPayable)}</span>
        </div>
      </div>
      <div class="tax-section"><div class="card-title">Monthly Breakdown</div>${bars}</div>
      <div style="margin-top:16px;">${report.notes.map(n => `<div class="tax-note">• ${n}</div>`).join('')}</div>
    </div>
  `;
}

function buildBarChart(months) {
  if (!months.length) return '<p style="color:var(--text-muted);">No monthly data.</p>';
  const maxVal = Math.max(...months.map(m => Math.max(m.income, m.expenses)), 1);
  const legend = `<div style="display:flex;gap:16px;font-size:11px;color:var(--text-muted);margin-bottom:6px;">
    <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(63,185,80,0.6);margin-right:4px;"></span>Income</span>
    <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:rgba(248,81,73,0.5);margin-right:4px;"></span>Expenses</span>
  </div>`;
  const barHtml = months.map(m => {
    const iH = Math.max(4, Math.round((m.income/maxVal)*80));
    const eH = Math.max(4, Math.round((m.expenses/maxVal)*80));
    return `<div class="bar-group" title="${m.label}"><div class="bar-wrap"><div class="bar-inc" style="height:${iH}px"></div><div class="bar-exp" style="height:${eH}px"></div></div><div class="bar-label">${m.label.slice(0,3)}</div></div>`;
  }).join('');
  return legend + `<div class="bar-chart">${barHtml}</div>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtAmount(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-JM', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function escHtml(s)  { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s)  { return String(s||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function today()     { return new Date().toISOString().slice(0,10); }

function toast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTO-UPDATER UI
// ═══════════════════════════════════════════════════════════════════════════════

function setupUpdater() {
  if (!window.electronAPI?.updater) return;

  const updater = window.electronAPI.updater;
  const banner  = document.getElementById('update-banner');
  const checkBtn = document.getElementById('check-update-btn');

  // Show current version
  updater.getVersion().then(v => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${v}`;
  }).catch(() => {});

  // Manual check button
  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled  = true;
      checkBtn.textContent = 'Checking…';
      await updater.check();
      setTimeout(() => {
        checkBtn.disabled  = false;
        checkBtn.textContent = '↑ Check for updates';
      }, 3000);
    });
  }

  // ─── Event handlers ────────────────────────────────────────────────────

  updater.on('updater:checking', () => {
    showBanner('checking', '🔍', 'Checking for updates…', '');
  });

  updater.on('updater:not-available', data => {
    showBanner('available', '✓', `You're on the latest version`, `v${data?.version || ''} is up to date`);
    setTimeout(() => { banner.style.display = 'none'; }, 4000);
  });

  updater.on('updater:available', data => {
    showBanner('available', '🆕',
      `Update available — v${data.version}`,
      `A new version is ready to download.`,
      [{
        label: 'Download Now',
        action: async () => {
          await updater.download();
        },
        style: 'btn-primary',
      }, {
        label: 'Dismiss',
        action: () => { banner.style.display = 'none'; },
        style: 'btn-secondary',
      }]
    );
  });

  updater.on('updater:progress', data => {
    showBanner('progress', '⬇️',
      `Downloading update… ${data.percent}%`,
      `${data.transferred} / ${data.total}  ·  ${data.bytesPerSecond}`,
      [], data.percent
    );
  });

  updater.on('updater:downloaded', data => {
    showBanner('downloaded', '✅',
      `Update v${data.version} ready to install`,
      'The app will restart automatically. Save your work first.',
      [{
        label: 'Restart & Install Now',
        action: () => updater.install(),
        style: 'btn-success',
      }, {
        label: 'Install on Next Close',
        action: () => { banner.style.display = 'none'; },
        style: 'btn-secondary',
      }]
    );
  });

  updater.on('updater:error', data => {
    showBanner('error-state', '⚠️',
      'Update check failed',
      data?.message || 'Could not reach update server.',
      [{ label: 'Dismiss', action: () => { banner.style.display = 'none'; }, style: 'btn-secondary' }]
    );
  });
}

/**
 * Render the update banner with given state.
 * @param {string} stateClass  CSS class (available|progress|downloaded|error-state)
 * @param {string} icon        Emoji icon
 * @param {string} title       Bold title
 * @param {string} sub         Subtitle / detail
 * @param {Array}  buttons     [{ label, action, style }]
 * @param {number} [pct]       Download percent (0–100) for progress bar
 */
function showBanner(stateClass, icon, title, sub, buttons = [], pct = null) {
  const banner = document.getElementById('update-banner');
  banner.className = stateClass;
  banner.style.display = 'flex';

  const progressBar = pct != null
    ? `<div class="update-progress-bar"><div class="update-progress-fill" style="width:${pct}%"></div></div>`
    : '';

  const btnHtml = buttons.map(b =>
    `<button class="btn ${b.style} btn-sm update-action-btn">${b.label}</button>`
  ).join('');

  banner.innerHTML = `
    <div class="update-banner-icon">${icon}</div>
    <div class="update-banner-text">
      <div class="update-banner-title">${escHtml(title)}</div>
      ${sub ? `<div class="update-banner-sub">${escHtml(sub)}</div>` : ''}
      ${progressBar}
    </div>
    ${btnHtml}
  `;

  // Attach button actions
  const btns = banner.querySelectorAll('.update-action-btn');
  buttons.forEach((b, i) => {
    if (btns[i]) btns[i].addEventListener('click', b.action);
  });
}

// Init updater after DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  setupUpdater();
});
