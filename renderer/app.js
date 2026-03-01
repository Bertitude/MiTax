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

// ─── Category Mappings ────────────────────────────────────────────────────────
// Persisted in localStorage as { [categoryId]: { _raw, incomeType?, isDeductible?, ignore? } }

const CAT_MAPPING_KEY = 'lm_cat_mappings';

function getCategoryMappings() {
  try { return JSON.parse(localStorage.getItem(CAT_MAPPING_KEY) || '{}'); }
  catch { return {}; }
}

function saveCategoryMapping(categoryId, value) {
  const mappings = getCategoryMappings();
  if (!value) { delete mappings[categoryId]; }
  else        { mappings[categoryId] = value; }
  localStorage.setItem(CAT_MAPPING_KEY, JSON.stringify(mappings));
}

const CAT_MAP_OPTIONS = [
  { value: '',                 label: '— Not mapped (use keyword rules)' },
  { value: 'income:business',  label: 'Income → Business / Professional' },
  { value: 'income:foreign',   label: 'Income → Foreign-Sourced' },
  { value: 'income:investment',label: 'Income → Investment' },
  { value: 'income:rental',    label: 'Income → Rental' },
  { value: 'income:other',     label: 'Income → Other' },
  { value: 'expense',          label: 'Deductible Expense' },
  { value: 'ignore',           label: 'Ignore (exclude from tax)' },
];

function renderCategoryMappings() {
  const tbody = document.getElementById('cat-map-tbody');
  if (!tbody) return;
  const cats = state.lmCategories;
  if (!cats.length) {
    tbody.innerHTML = '<tr><td colspan="2" style="color:var(--text-muted);text-align:center;padding:24px;">Connect your LunchMoney API to load categories.</td></tr>';
    updateCatMapBadge();
    return;
  }
  const mappings = getCategoryMappings();
  tbody.innerHTML = '';
  cats.forEach(cat => {
    const id  = String(cat.id);
    const cur = mappings[id] ? mappings[id]._raw : '';
    const opts = CAT_MAP_OPTIONS.map(o =>
      `<option value="${escAttr(o.value)}"${cur === o.value ? ' selected' : ''}>${escHtml(o.label)}</option>`
    ).join('');
    const cls = cur === 'expense' ? ' mapped-expense' : cur === 'ignore' ? ' mapped-ignore' : cur ? ' mapped' : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-size:12px;">${escHtml(cat.name)}</td>
      <td><select class="cat-map-select${cls}" data-cat-id="${id}">${opts}</select></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.cat-map-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const catId = e.target.dataset.catId;
      const val   = e.target.value;
      e.target.classList.remove('mapped', 'mapped-expense', 'mapped-ignore');
      if      (val === 'expense') e.target.classList.add('mapped-expense');
      else if (val === 'ignore')  e.target.classList.add('mapped-ignore');
      else if (val)               e.target.classList.add('mapped');
      if (!val) {
        saveCategoryMapping(catId, null);
      } else {
        const mapping = { _raw: val };
        if (val.startsWith('income:')) mapping.incomeType = val.split(':')[1];
        if (val === 'expense')         mapping.isDeductible = true;
        if (val === 'ignore')          mapping.ignore = true;
        saveCategoryMapping(catId, mapping);
      }
      updateCatMapBadge();
    });
  });
  updateCatMapBadge();
}

function updateCatMapBadge() {
  const count = Object.keys(getCategoryMappings()).length;
  const badge = document.getElementById('cat-map-badge');
  if (badge) {
    badge.textContent  = count ? `${count} mapped` : '';
    badge.style.display = count ? '' : 'none';
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initYearSelects();
  setupNav();
  setupDashboard();
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
  refreshDashboard();
  refreshTracker();
  refreshHistory();
  refreshFilingHistory();
});

/**
 * Populate year-selection dropdowns with a rolling 5-year window so they always
 * show the current year as the default, regardless of when the app is opened.
 */
function initYearSelects() {
  const currentYear = new Date().getFullYear();

  // Tracker year — default to current year
  const trackerSel = document.getElementById('tracker-year');
  if (trackerSel) {
    trackerSel.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 4; y--) {
      const opt = document.createElement('option');
      opt.value       = y;
      opt.textContent = y;
      if (y === currentYear) opt.selected = true;
      trackerSel.appendChild(opt);
    }
  }

  // Tax year — default to prior year (S04 is filed for the previous tax year)
  const taxSel = document.getElementById('tax-year-select');
  if (taxSel) {
    taxSel.innerHTML = '';
    for (let y = currentYear - 1; y >= currentYear - 5; y--) {
      const opt = document.createElement('option');
      opt.value       = y;
      opt.textContent = y;
      if (y === currentYear - 1) opt.selected = true;
      taxSel.appendChild(opt);
    }
  }

  // S04A year — default to current year (provisional tax is for the current year)
  const s04aSel = document.getElementById('s04a-year-select');
  if (s04aSel) {
    s04aSel.innerHTML = '';
    for (let y = currentYear; y >= currentYear - 3; y--) {
      const opt = document.createElement('option');
      opt.value       = y;
      opt.textContent = y;
      if (y === currentYear) opt.selected = true;
      s04aSel.appendChild(opt);
    }
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const PAGE_TITLES = {
  dashboard: 'Dashboard',      import: 'Import Statements',
  tracker:   'Coverage Tracker', history: 'Upload History',
  tax:       'S04 Tax Return', settings: 'Settings',
};

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      item.classList.add('active');
      document.getElementById(`${view}-view`).classList.add('active');
      document.getElementById('page-title').textContent = PAGE_TITLES[view] || view;
      if (view === 'dashboard') refreshDashboard();
      if (view === 'tracker')   refreshTracker();
      if (view === 'history')   refreshHistory();
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

    renderCategoryMappings();

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
    if (result.success) {
      // Some parsers (e.g. UNFCU) return an array when a single PDF contains
      // multiple accounts. Expand them into separate queue items so each account
      // can be mapped and imported independently.
      if (Array.isArray(result.data)) {
        const idx = state.queue.indexOf(item);
        const expanded = result.data.map((parsed, i) => ({
          id:        Date.now() + Math.random() + i,
          name:      `${item.name} — ${parsed.accountName}`,
          path:      item.path,
          status:    'ready',
          parsed,
          assetId:   null,
          assetName: null,
        }));
        state.queue.splice(idx, 1, ...expanded);
      } else {
        item.parsed = result.data;
        item.status = 'ready';
      }
    } else {
      item.status = 'error';
      toast(`Failed to parse ${item.name}: ${result.error}`, 'error');
    }
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

  const assetOptions = () => state.lmAssets.map(a =>
    `<option value="${a.id}">${escHtml(a.display_name || a.name)} (${(a.currency || '').toUpperCase()})</option>`
  ).join('');

  for (const item of readyItems) {
    const { asset: suggestion, confidence, reasons } = autoSuggestAsset(item.parsed);

    const confidenceBadge = suggestion
      ? confidence === 'high'
        ? `<span class="confidence-badge confidence-high">● High confidence</span>`
        : confidence === 'medium'
          ? `<span class="confidence-badge confidence-medium">◑ Medium confidence</span>`
          : `<span class="confidence-badge confidence-low">○ Low confidence</span>`
      : `<span class="confidence-badge confidence-none">No match found</span>`;

    const matchReasons = reasons.length
      ? `<div class="match-reasons">${reasons.map(r => `<span>✓ ${escHtml(r)}</span>`).join('')}</div>`
      : '';

    const accNumInfo = item.parsed.accountNumber
      ? `<span style="font-family:monospace;background:var(--surface2);padding:1px 6px;border-radius:4px;font-size:11px;">···${escHtml(item.parsed.accountNumber)}</span>`
      : '';

    const row = document.createElement('div');
    row.className = 'account-modal-row';
    row.innerHTML = `
      <div class="account-modal-info">
        <div class="account-modal-label">
          <strong>${escHtml(item.parsed.institution)}</strong> — ${escHtml(item.parsed.accountName)}
          ${accNumInfo}
          <span class="badge badge-yellow" style="margin-left:4px;">${escHtml(item.parsed.currency)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
          ${item.parsed.transactions?.length || 0} transactions · ${item.parsed.period?.start || '?'} → ${item.parsed.period?.end || '?'}
        </div>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          ${confidenceBadge}
          ${matchReasons}
        </div>
        <select class="account-select" data-id="${item.id}" style="width:100%;">
          <option value="">— Select account —</option>
          ${assetOptions()}
          <option value="__create__">➕ Create new account in LunchMoney…</option>
        </select>
      </div>
    `;

    const sel = row.querySelector('.account-select');
    if (suggestion) sel.value = String(suggestion.id);

    sel.addEventListener('change', e => {
      if (e.target.value === '__create__') {
        openCreateForm(item);
        e.target.value = suggestion ? String(suggestion.id) : '';
      }
    });

    rows.appendChild(row);
  }

  document.getElementById('account-modal').classList.add('open');
}

/**
 * Score-based asset matching.
 * Returns { asset, confidence: 'high'|'medium'|'low'|null, reasons: [] }
 */
function autoSuggestAsset(parsed) {
  if (!parsed || !state.lmAssets.length) return { asset: null, confidence: null, reasons: [] };

  const inst    = (parsed.institution || '').toLowerCase().trim();
  const cur     = (parsed.currency    || '').toLowerCase();
  const accNum  = (parsed.accountNumber || '').replace(/\D/g, '');
  const pType   = parsed.accountType || '';

  // LunchMoney type → parsed accountType mapping for scoring
  const typeMap = {
    cash:                  ['chequing','savings','checking'],
    credit:                ['credit_card','credit'],
    investment:            ['investment','brokerage','securities'],
    loan:                  ['loan','mortgage'],
    'real estate':         ['real_estate','property'],
    vehicle:               ['vehicle','auto'],
    cryptocurrency:        ['crypto','cryptocurrency'],
    'employee compensation':['payroll','employment'],
  };

  let best = null;
  let bestScore = 0;
  let bestReasons = [];

  for (const a of state.lmAssets) {
    let score = 0;
    const reasons = [];

    const aName = ((a.display_name || a.name || '') + ' ' + (a.institution_name || '')).toLowerCase();
    const aCur  = (a.currency || '').toLowerCase();
    const aType = (a.type_name || '').toLowerCase();

    // ── Account number match (strongest signal) ─────────────────────────────
    if (accNum.length >= 4) {
      const aNameDigits = aName.replace(/\D/g, '');
      if (aNameDigits.endsWith(accNum) || aName.includes(accNum)) {
        score += 50;
        reasons.push(`Account ···${accNum} matched`);
      }
    }

    // ── Institution name match ───────────────────────────────────────────────
    if (inst && aName.includes(inst)) {
      score += 20;
      reasons.push('Institution name matched');
    } else if (inst) {
      // Partial: first word of institution in asset name
      const firstWord = inst.split(/\s+/)[0];
      if (firstWord.length > 2 && aName.includes(firstWord)) {
        score += 8;
        reasons.push('Institution partially matched');
      }
    }

    // ── Currency match ───────────────────────────────────────────────────────
    if (cur && aCur === cur) {
      score += 10;
      reasons.push(`Currency ${cur.toUpperCase()} matched`);
    }

    // ── Account type match ───────────────────────────────────────────────────
    if (pType && typeMap[aType] && typeMap[aType].includes(pType)) {
      score += 8;
      reasons.push('Account type matched');
    }

    if (score > bestScore) {
      bestScore   = score;
      best        = a;
      bestReasons = reasons;
    }
  }

  if (!best || bestScore < 8) return { asset: null, confidence: null, reasons: [] };

  const confidence = bestScore >= 50 ? 'high' : bestScore >= 20 ? 'medium' : 'low';
  return { asset: best, confidence, reasons: bestReasons };
}

function openCreateForm(item) {
  const typeMap = {
    chequing:'cash', checking:'cash', savings:'cash', credit_card:'credit',
    loan:'loan', mortgage:'loan', investment:'investment', brokerage:'investment',
    international:'cash', unknown:'other',
  };

  document.getElementById('new-account-name').value         = (item.parsed.accountName || '').substring(0, 45);
  document.getElementById('new-account-display-name').value = '';
  document.getElementById('new-account-institution').value  = (item.parsed.institution || '').substring(0, 50);
  document.getElementById('new-account-type').value         = typeMap[item.parsed.accountType] || 'cash';
  document.getElementById('new-account-subtype').value      = item.parsed.accountType === 'savings' ? 'savings'
                                                            : item.parsed.accountType === 'credit_card' ? 'prepaid credit card'
                                                            : item.parsed.accountType === 'investment' ? 'brokerage' : '';
  document.getElementById('new-account-currency').value     = item.parsed.currency || 'JMD';
  document.getElementById('new-account-balance').value      = '0';
  document.getElementById('new-account-balance-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('new-account-closed-on').value    = '';
  document.getElementById('new-account-exclude-tx').checked = false;

  const form = document.getElementById('create-account-form');
  form.style.display  = 'block';
  form.dataset.forId  = item.id;
  document.getElementById('create-account-error').style.display = 'none';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function createNewAccount() {
  const name          = document.getElementById('new-account-name').value.trim();
  const displayName   = document.getElementById('new-account-display-name').value.trim();
  const institution   = document.getElementById('new-account-institution').value.trim();
  const typeName      = document.getElementById('new-account-type').value;
  const subtypeName   = document.getElementById('new-account-subtype').value.trim();
  const currency      = document.getElementById('new-account-currency').value;
  const balance       = parseFloat(document.getElementById('new-account-balance').value) || 0;
  const balanceAsOf   = document.getElementById('new-account-balance-date').value || null;
  const closedOn      = document.getElementById('new-account-closed-on').value || null;
  const excludeTx     = document.getElementById('new-account-exclude-tx').checked;
  const errEl         = document.getElementById('create-account-error');

  if (!name)          { errEl.textContent = 'Account name is required.'; errEl.style.display = 'block'; return; }
  if (!state.apiKey)  { errEl.textContent = 'No API key. Connect in Settings first.'; errEl.style.display = 'block'; return; }

  const btn     = document.getElementById('create-account-btn');
  btn.disabled  = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  const result = await window.electronAPI.createLMAsset(state.apiKey, {
    name, displayName, typeName, subtypeName, currency,
    institutionName: institution, balance, balanceAsOf, closedOn,
    excludeTransactions: excludeTx,
  });

  btn.disabled  = false;
  btn.innerHTML = 'Create in LunchMoney';

  if (!result.success) {
    errEl.textContent   = `Error: ${result.error}`;
    errEl.style.display = 'block';
    return;
  }

  const newAsset = result.data;
  state.lmAssets.push(newAsset);
  toast(`✓ Created "${name}" in LunchMoney`, 'success');

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
  document.getElementById('val-deselect-dupes').addEventListener('click', () => {
    // Uncheck (but keep visible) all rows flagged as duplicates
    state.validateRows.forEach((row, i) => {
      if (!row._isDupe) return;
      row._include = false;
      const cb = document.querySelector(`#validate-tbody .val-row-check[data-idx="${i}"]`);
      if (cb) cb.checked = false;
    });
    document.getElementById('val-check-all').checked = false;
    updateSelectedCount();
    toast('Duplicate rows deselected.', 'info');
  });
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
    _isDupe:    false,
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

  // ── Duplicate check against LunchMoney ───────────────────────────────────
  if (state.apiKey && state.validateRows.length) {
    try {
      toast('Checking for existing transactions…', 'info', 2500);
      const checkPayload = state.validateRows.map(r => ({
        assetId: r._assetId,
        date:    r.date,
        amount:  r.amount,
      }));
      const dupeRes = await window.electronAPI.checkDuplicates({
        apiKey:       state.apiKey,
        transactions: checkPayload,
      });
      if (dupeRes.success && dupeRes.data) {
        dupeRes.data.forEach((isDupe, i) => {
          if (isDupe) {
            state.validateRows[i]._isDupe   = true;
            state.validateRows[i]._include  = false;  // pre-uncheck
          }
        });
      }
    } catch (e) {
      console.warn('[openValidateModal] duplicate check error:', e);
    }
  }

  const dupeCount = state.validateRows.filter(r => r._isDupe).length;
  const dupeBtn   = document.getElementById('val-deselect-dupes');
  const dupeCnt   = document.getElementById('val-dupe-count');
  if (dupeBtn) {
    dupeBtn.style.display = dupeCount ? '' : 'none';
    if (dupeCnt) dupeCnt.textContent = `(${dupeCount})`;
  }

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
    if (row._isDupe) tr.classList.add('dupe-row');
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
        ${row._isDupe  ? '<span class="dupe-badge" title="Already exists in LunchMoney">DUPE</span>' : ''}
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

  // ── Category mapping panel ──────────────────────────────────────────────
  const toggleArea = document.getElementById('cat-map-toggle');
  const toggleBtn  = document.getElementById('cat-map-toggle-btn');
  const panel      = document.getElementById('cat-map-panel');
  if (toggleArea && panel) {
    toggleArea.addEventListener('click', e => {
      // Don't trigger on clicks inside the panel itself
      if (e.target.closest('#cat-map-panel')) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
      if (toggleBtn) toggleBtn.textContent = open ? '▶ Show' : '▼ Hide';
    });
  }

  const catSearch = document.getElementById('cat-map-search');
  if (catSearch) {
    catSearch.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('#cat-map-tbody tr').forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  const clearAllBtn = document.getElementById('cat-map-clear-all');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
      localStorage.removeItem(CAT_MAPPING_KEY);
      renderCategoryMappings();
      toast('All category mappings cleared.', 'info');
    });
  }

  // ── S04A button ────────────────────────────────────────────────────────
  const s04aBtn = document.getElementById('generate-s04a-btn');
  if (s04aBtn) s04aBtn.addEventListener('click', generateS04AEstimate);

  // ── Filing history refresh ─────────────────────────────────────────────
  const refreshFilingsBtn = document.getElementById('refresh-filings-btn');
  if (refreshFilingsBtn) refreshFilingsBtn.addEventListener('click', refreshFilingHistory);
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

  // Build clean mappings for main process (strip internal _raw field)
  const userCategoryMappings = {};
  for (const [catId, val] of Object.entries(getCategoryMappings())) {
    const { _raw, ...rest } = val;  // eslint-disable-line no-unused-vars
    userCategoryMappings[catId] = rest;
  }

  const result = await window.electronAPI.generateS04({ year, apiKey: state.apiKey || null, manualData, userCategoryMappings });
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

      <!-- Save as Filed form (collapsed by default) -->
      <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:16px;">
        <button class="btn btn-secondary btn-sm" id="show-save-filing-btn">💾 Save as Filed</button>
        <div id="save-filing-form" class="filing-save-form" style="display:none;margin-top:12px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--accent);">Record S04 Filing for ${report.year}</div>
          <div class="grid-3">
            <div class="form-group">
              <label style="font-size:12px;">Filed Date</label>
              <input type="date" id="filing-date" value="${new Date().toISOString().slice(0,10)}" style="font-size:12px;" />
            </div>
            <div class="form-group">
              <label style="font-size:12px;">Amount Paid (JMD)</label>
              <input type="number" id="filing-amount-paid" step="0.01" value="${report.totalTaxPayable}" style="font-size:12px;" />
            </div>
            <div class="form-group">
              <label style="font-size:12px;">Status</label>
              <select id="filing-status" style="font-size:12px;">
                <option value="draft">Draft (not yet submitted)</option>
                <option value="filed" selected>Filed (submitted to TAJ)</option>
                <option value="paid">Filed &amp; Paid</option>
              </select>
            </div>
          </div>
          <div class="form-group" style="margin-top:4px;">
            <label style="font-size:12px;">Notes (optional)</label>
            <input type="text" id="filing-notes" placeholder="e.g. TAJ reference number, agent name…" style="font-size:12px;" />
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button class="btn btn-success btn-sm" id="confirm-save-filing-btn">✓ Save Filing</button>
            <button class="btn btn-secondary btn-sm" id="cancel-save-filing-btn">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wire the save-filing form controls (inside the dynamic HTML)
  document.getElementById('show-save-filing-btn').addEventListener('click', () => {
    const form = document.getElementById('save-filing-form');
    const btn  = document.getElementById('show-save-filing-btn');
    const open = form.style.display !== 'none';
    form.style.display = open ? 'none' : 'block';
    btn.textContent    = open ? '💾 Save as Filed' : '▲ Collapse';
  });
  document.getElementById('cancel-save-filing-btn').addEventListener('click', () => {
    document.getElementById('save-filing-form').style.display = 'none';
    document.getElementById('show-save-filing-btn').textContent = '💾 Save as Filed';
  });
  document.getElementById('confirm-save-filing-btn').addEventListener('click', () => saveS04Filing(report));
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

// ═══════════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

const QUARTER_MONTHS     = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
const QUARTER_MONTH_NAMES = [['January','March'],['April','June'],['July','September'],['October','December']];
const QUARTER_DUE_DATES   = ['March 15','June 15','September 15','December 15'];

function currentQuarter() {
  const now = new Date();
  return Math.ceil((now.getMonth() + 1) / 3);
}

function setupDashboard() {
  const btn = document.getElementById('dash-refresh-btn');
  if (btn) btn.addEventListener('click', refreshDashboard);
}

async function refreshDashboard() {
  const now     = new Date();
  const year    = now.getFullYear();
  const quarter = currentQuarter();
  const qLabel  = `Q${quarter} ${year}`;
  const qSub    = `${QUARTER_MONTH_NAMES[quarter-1][0]} – ${QUARTER_MONTH_NAMES[quarter-1][1]} ${year}`;

  document.getElementById('dash-quarter-label').textContent  = qLabel;
  document.getElementById('dash-quarter-sub').textContent    = qSub;
  document.getElementById('dash-missing-quarter').textContent = qLabel;

  const btn = document.getElementById('dash-refresh-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Loading…'; }

  const result = await window.electronAPI.getDashboardData({
    apiKey:  state.apiKey || null,
    year,
    quarter,
  });

  if (btn) { btn.disabled = false; btn.innerHTML = '↻ Refresh'; }
  if (!result.success) { toast(`Dashboard error: ${result.error}`, 'error'); return; }

  const { assets, ytdIncome, trackerAccounts, quarterlyTaxEstimate } = result.data;

  // Keep state in sync if we got fresh asset data
  if (assets && assets.length) {
    state.lmAssets = assets;
    document.getElementById('api-label').textContent = `Connected · ${assets.length} accounts`;
  }

  renderDashboardBalances(assets || []);
  renderDashboardMissing(trackerAccounts || [], qLabel);
  renderDashboardTaxEstimate(quarterlyTaxEstimate, ytdIncome || 0, year, quarter);
}

function renderDashboardBalances(assets) {
  const el      = document.getElementById('dash-balances');
  const countEl = document.getElementById('dash-balance-count');
  if (!assets.length) {
    if (countEl) countEl.textContent = '';
    el.innerHTML = `<div class="empty-state" style="padding:24px 0;">
      <div class="empty-icon">🔗</div>
      <p>Connect to LunchMoney in Settings to see live account balances.</p>
    </div>`;
    return;
  }

  if (countEl) countEl.textContent = `${assets.length} account${assets.length !== 1 ? 's' : ''}`;

  const typeIcon = {
    cash:'💳', credit:'💳', investment:'📈', loan:'🏦',
    'real estate':'🏠', vehicle:'🚗', cryptocurrency:'₿', other:'💰',
  };

  // Group by institution name for visual clarity
  const totalByCurrency = {};
  assets.forEach(a => {
    const cur = (a.currency || 'JMD').toUpperCase();
    totalByCurrency[cur] = (totalByCurrency[cur] || 0) + parseFloat(a.balance || 0);
  });

  el.innerHTML = assets.map(a => {
    const icon = typeIcon[(a.type_name || '').toLowerCase()] || '💰';
    const bal  = parseFloat(a.balance || 0);
    const isNeg = bal < 0;
    const cur  = (a.currency || 'JMD').toUpperCase();
    const asOf = a.balance_as_of || '';
    return `<div class="dash-balance-card">
      <div class="dash-balance-icon">${icon}</div>
      <div class="dash-balance-body">
        <div class="dash-balance-name" title="${escHtml(a.display_name || a.name)}">${escHtml(a.display_name || a.name)}</div>
        <div class="dash-balance-inst">${escHtml(a.institution_name || a.type_name || '')}</div>
        <div class="dash-balance-amount ${isNeg ? 'amount-neg' : ''}">
          ${cur} ${fmtAmount(bal)}
        </div>
        ${asOf ? `<div class="dash-balance-date">as of ${escHtml(asOf)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderDashboardMissing(trackerAccounts, qLabel) {
  const el = document.getElementById('dash-missing');
  if (!trackerAccounts.length) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">
      No uploaded accounts tracked yet. Upload statements to start tracking coverage.
    </div>`;
    return;
  }

  const withMissing    = trackerAccounts.filter(a => a.quarterMissing.length > 0);
  const withoutMissing = trackerAccounts.filter(a => a.quarterMissing.length === 0);

  if (!withMissing.length) {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--accent2);font-size:13px;padding:4px 0;">
      <span style="font-size:20px;">✓</span>
      <span>All ${trackerAccounts.length} tracked account${trackerAccounts.length !== 1 ? 's' : ''} have statements for ${qLabel}.</span>
    </div>`;
    return;
  }

  const warningRows = withMissing.map(acc => {
    const months = acc.quarterMissing.map(m => m.label).join(', ');
    return `<div class="dash-missing-row dash-missing-warn">
      <span class="dash-missing-status warn">⚠</span>
      <span class="dash-missing-name">${escHtml(acc.institution)} · ${escHtml(acc.account_name)}</span>
      <span class="dash-missing-detail">Missing: ${escHtml(months)}</span>
    </div>`;
  }).join('');

  const okRows = withoutMissing.map(acc =>
    `<div class="dash-missing-row">
      <span class="dash-missing-status ok">✓</span>
      <span class="dash-missing-name">${escHtml(acc.institution)} · ${escHtml(acc.account_name)}</span>
      <span class="dash-missing-detail">All months covered for ${qLabel}</span>
    </div>`
  ).join('');

  el.innerHTML = warningRows + okRows;
}

function renderDashboardTaxEstimate(estimate, ytdIncome, year, quarter) {
  const el  = document.getElementById('dash-tax');
  const fmt = v => `$${Number(v || 0).toLocaleString('en-JM', { minimumFractionDigits: 2 })}`;
  const dueDate = `${QUARTER_DUE_DATES[quarter-1]}, ${year}`;

  if (!estimate) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">
      ${state.apiKey
        ? 'No income transactions found in LunchMoney for this year yet.'
        : 'Connect to LunchMoney in Settings to see quarterly tax estimates.'}
    </div>`;
    return;
  }

  if (estimate.annualEstimate === 0) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">
      No income found for ${year} yet — estimates will appear once income transactions are present in LunchMoney.
    </div>`;
    return;
  }

  const contribTotal = estimate.nis + estimate.nht + estimate.edTax;

  el.innerHTML = `
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6;">
      Based on <strong style="color:var(--text);">${fmt(ytdIncome)} YTD income</strong>
      (${estimate.monthsElapsed.toFixed(1)} months elapsed) · Projected annual: <strong style="color:var(--text);">${fmt(estimate.annualEstimate)}</strong>
      · Standard 20% deduction applied · Amounts in JMD
    </div>
    <div class="grid-3" style="margin-bottom:16px;">
      <div class="stat-card">
        <div class="stat-label">Q${quarter} Total Due</div>
        <div class="stat-value" style="color:var(--warn);">${fmt(estimate.total)}</div>
        <div class="stat-sub">Due ${dueDate}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Income Tax</div>
        <div class="stat-value" style="font-size:18px;">${fmt(estimate.incomeTax)}</div>
        <div class="stat-sub">25% / 30% rate</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">NIS + NHT + Ed Tax</div>
        <div class="stat-value" style="font-size:18px;">${fmt(contribTotal)}</div>
        <div class="stat-sub">Contributions</div>
      </div>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;margin-bottom:12px;">
      <div><span style="color:var(--text-muted);">NIS (3%): </span><strong>${fmt(estimate.nis)}</strong></div>
      <div><span style="color:var(--text-muted);">NHT (2%): </span><strong>${fmt(estimate.nht)}</strong></div>
      <div><span style="color:var(--text-muted);">Education Tax (2.25%): </span><strong>${fmt(estimate.edTax)}</strong></div>
      <div><span style="color:var(--text-muted);">Income Tax: </span><strong>${fmt(estimate.incomeTax)}</strong></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);">
      ⚠ Quarterly installments are due March 15, June 15, September 15, and December 15.
      Go to <em>S04 Tax Return</em> for a full annual estimate. Consult TAJ for official guidance.
    </div>
  `;
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

// ═══════════════════════════════════════════════════════════════════════════════
//  TAX FILINGS — History + Save + S04A
// ═══════════════════════════════════════════════════════════════════════════════

const fmt = v => `$${Number(v || 0).toLocaleString('en-JM', { minimumFractionDigits: 2 })}`;

// ─── Save S04 Filing ──────────────────────────────────────────────────────────

async function saveS04Filing(report) {
  const btn = document.getElementById('confirm-save-filing-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const filedDate = document.getElementById('filing-date')?.value || null;
  const amtPaid   = parseFloat(document.getElementById('filing-amount-paid')?.value || 0);
  const status    = document.getElementById('filing-status')?.value  || 'filed';
  const notes     = document.getElementById('filing-notes')?.value   || null;

  const payload = {
    type:        's04',
    year:        report.year,
    quarter:     null,
    filedDate,
    dueDate:     null,
    grossIncome: report.income.grossIncome,
    taxPayable:  report.totalTaxPayable,
    nis:         report.contributions.nis,
    nht:         report.contributions.nht,
    edTax:       report.contributions.educationTax,
    incomeTax:   report.tax.incomeTax,
    amountPaid:  amtPaid,
    status,
    reportJson:  report,
    notes,
  };

  const res = await window.electronAPI.saveFilingRecord(payload);
  if (btn) { btn.disabled = false; btn.textContent = '✓ Save Filing'; }

  if (!res.success) {
    toast(`Failed to save filing: ${res.error}`, 'error');
    return;
  }

  toast(`S04 ${report.year} filing saved!`, 'success');
  document.getElementById('save-filing-form').style.display = 'none';
  document.getElementById('show-save-filing-btn').textContent = '💾 Save as Filed';
  refreshFilingHistory();
}

// ─── Filing History ───────────────────────────────────────────────────────────

async function refreshFilingHistory() {
  const wrap = document.getElementById('filing-history-wrap');
  if (!wrap) return;

  const res = await window.electronAPI.getFilingRecords();
  if (!res.success) {
    wrap.innerHTML = `<div class="filing-empty" style="color:var(--warn);">Error loading filings: ${escHtml(res.error || '')}</div>`;
    return;
  }

  const filings = res.data || [];
  if (!filings.length) {
    wrap.innerHTML = '<div class="filing-empty">No filings saved yet. Generate an S04 report and click <strong>Save as Filed</strong>.</div>';
    return;
  }

  const statusBadge = s => `<span class="filing-status ${s}">${s}</span>`;
  const fmtDate     = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-JM', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
  const typeLabel   = (type, q) => type === 's04a' ? `S04A Q${q}` : 'S04';

  wrap.innerHTML = `
    <div class="table-wrap" style="max-height:280px;overflow-y:auto;">
      <table class="filing-table">
        <thead>
          <tr>
            <th>Type</th><th>Year</th><th>Filed</th><th>Gross Income</th>
            <th>Tax Payable</th><th>Paid</th><th>Status</th><th style="width:60px;"></th>
          </tr>
        </thead>
        <tbody>
          ${filings.map(f => `
            <tr data-filing-id="${f.id}">
              <td><strong>${typeLabel(f.type, f.quarter)}</strong></td>
              <td>${f.year}</td>
              <td style="font-size:11px;">${fmtDate(f.filed_date)}</td>
              <td>${fmt(f.gross_income)}</td>
              <td style="color:var(--warn);">${fmt(f.tax_payable)}</td>
              <td style="color:var(--accent2);">${fmt(f.amount_paid)}</td>
              <td>${statusBadge(f.status)}</td>
              <td>
                <button class="btn btn-danger btn-sm filing-delete-btn" data-id="${f.id}" title="Delete this record" style="padding:2px 8px;font-size:11px;">✕</button>
              </td>
            </tr>
            ${f.notes ? `<tr><td colspan="8" style="font-size:11px;color:var(--text-muted);padding-top:0;border-top:none;">↳ ${escHtml(f.notes)}</td></tr>` : ''}
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  wrap.querySelectorAll('.filing-delete-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const id = parseInt(e.target.dataset.id);
      if (!confirm('Delete this filing record? This cannot be undone.')) return;
      const res = await window.electronAPI.deleteFilingRecord(id);
      if (res.success) { refreshFilingHistory(); toast('Filing deleted.', 'info'); }
      else toast(`Delete failed: ${res.error}`, 'error');
    });
  });
}

// ─── S04A Provisional Tax Estimate ───────────────────────────────────────────

async function generateS04AEstimate() {
  const btn  = document.getElementById('generate-s04a-btn');
  const wrap = document.getElementById('s04a-wrap');
  const year = parseInt(document.getElementById('s04a-year-select')?.value || new Date().getFullYear());

  btn.disabled = true;
  btn.textContent = '…';
  wrap.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px;"><span class="spinner"></span> Generating…</div>';

  const res = await window.electronAPI.generateS04A({ currentYear: year, apiKey: state.apiKey || null });
  btn.disabled = false;
  btn.textContent = 'Generate';

  if (!res.success) {
    wrap.innerHTML = `<div style="color:var(--warn);padding:12px;">Error: ${escHtml(res.error || 'Unknown error')}</div>`;
    return;
  }

  renderS04AEstimate(res.data);
}

function renderS04AEstimate(est) {
  const wrap = document.getElementById('s04a-wrap');
  if (!wrap) return;

  const now   = new Date();
  const fmtDt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-JM', { year: 'numeric', month: 'short', day: 'numeric' });

  const adjBadge = est.useAdjusted
    ? `<span class="badge" style="background:rgba(210,153,34,0.18);color:var(--warn2);font-size:10px;margin-left:8px;">Trend-adjusted</span>`
    : '';
  const priorInfo = est.hasPriorFiling
    ? `Prior year (${est.priorYear}) S04 on file · Tax: ${fmt(est.priorYearTaxPayable)}`
    : `No prior-year S04 filing found — estimated from current-year trends`;

  const quartersHtml = est.quarters.map(q => {
    const isPast    = new Date(q.dueDate) < now;
    const cls       = isPast ? ' overdue' : '';
    const diffBadge = est.useAdjusted && q.baseAmount !== q.recommendedAmount
      ? `<div class="s04a-quarter-base">Base: ${fmt(q.baseAmount)}</div>`
      : '';

    return `
      <div class="s04a-quarter${cls}">
        <div class="s04a-quarter-label">${escHtml(q.label)}</div>
        <div class="s04a-quarter-due">Due: ${escHtml(q.dueDateFormatted)}${isPast ? ' <span style="color:var(--warn);font-size:10px;">● Past due</span>' : ''}</div>
        <div class="s04a-quarter-amount">${fmt(q.recommendedAmount)}</div>
        ${diffBadge}
        <div class="s04a-quarter-save">
          <button class="btn btn-secondary btn-sm save-s04a-btn" data-quarter="${q.quarter}" data-due="${q.dueDate}" data-amount="${q.recommendedAmount}" data-year="${est.currentYear}" style="font-size:10px;padding:3px 8px;">
            💾 Save
          </button>
        </div>
      </div>`;
  }).join('');

  wrap.innerHTML = `
    <div style="margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <div style="font-size:13px;font-weight:600;">${est.currentYear} Quarterly Provisional Tax${adjBadge}</div>
      <div style="font-size:11px;color:var(--text-muted);flex:1;">${escHtml(priorInfo)}</div>
    </div>
    <div class="s04a-quarters">${quartersHtml}</div>
    <ul class="s04a-notes">${est.notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>
  `;

  // Wire "Save" buttons for individual quarters
  wrap.querySelectorAll('.save-s04a-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const { quarter, due, amount, year } = e.target.dataset;
      const res = await window.electronAPI.saveFilingRecord({
        type:        's04a',
        year:        parseInt(year),
        quarter:     parseInt(quarter),
        filedDate:   null,
        dueDate:     due,
        grossIncome: est.priorYearGrossIncome || 0,
        taxPayable:  parseFloat(amount),
        nis:         0, nht: 0, edTax: 0, incomeTax: 0,
        amountPaid:  0,
        status:      'draft',
        reportJson:  null,
        notes:       `S04A Q${quarter} ${year} provisional estimate`,
      });
      if (res.success) {
        toast(`S04A Q${quarter} saved to filing history.`, 'success');
        refreshFilingHistory();
      } else {
        toast(`Save failed: ${res.error}`, 'error');
      }
    });
  });
}
