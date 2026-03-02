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

// ─── Timezone Utilities ───────────────────────────────────────────────────────

const TZ_KEY       = 'lm_timezone';
const SETUP_DONE_KEY = 'lm_setup_complete';

/** Returns the IANA timezone string the user has configured, or 'system'. */
function getAppTimezone() {
  return localStorage.getItem(TZ_KEY) || 'system';
}

/** Returns the system's IANA timezone string detected by the browser. */
function getSystemTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Returns the current date as YYYY-MM-DD in the configured (or system) timezone.
 * Used wherever "today" matters for date-range calculations.
 */
function getAppNow() {
  const tz = getAppTimezone();
  const resolved = tz === 'system' ? getSystemTimezone() : tz;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: resolved,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Friendly label for a timezone string. */
function tzLabel(tz) {
  if (tz === 'system') return `Auto — ${getSystemTimezone()}`;
  try {
    const offset = new Intl.DateTimeFormat('en', { timeZoneName: 'short', timeZone: tz })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
    return `${tz.replace(/_/g, ' ')} (${offset})`;
  } catch { return tz; }
}

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
  setupAccountView();
  setupHistoryDetailModal();
  setupSidebarAccountSwitcher();
  restorePrefs();
  restoreProfile();

  // ── Multi-account startup ──────────────────────────────────────────────
  // 1. Try to load the active account from the DB.
  // 2. If none exists but localStorage has a legacy key, migrate it first.
  // 3. Connect with the resolved key.

  const activeRes = await window.electronAPI.lmAccounts.getActive();
  let startKey    = activeRes?.data?.api_key || null;

  if (!startKey && state.apiKey) {
    // First run after upgrade: migrate the localStorage key into the DB
    await window.electronAPI.lmAccounts.migrate({ apiKey: state.apiKey });
    const migratedRes = await window.electronAPI.lmAccounts.getActive();
    startKey = migratedRes?.data?.api_key || state.apiKey;
  }

  if (startKey) {
    state.apiKey = startKey;
    // Keep legacy input populated for fallback / test-connection button
    const legacyInput = document.getElementById('api-key-input');
    if (legacyInput) legacyInput.value = startKey;
    await connectAPI(startKey, false);
  }

  // Render account list in Settings (even if not connected)
  renderLMAccountsList();

  refreshDashboard();
  refreshTracker();
  refreshHistory();
  refreshFilingHistory();
  initTrackerYearSelect();

  // Show first-run welcome modal if the user hasn't completed setup yet
  maybeShowWelcomeModal();
});

// ─── First-Run Welcome Modal ──────────────────────────────────────────────────

/**
 * Shows the first-run welcome modal the very first time the app is launched.
 * When the user clicks "Get Started", their timezone & currency selections are
 * persisted, setup is marked complete, and the modal closes.
 */
function maybeShowWelcomeModal() {
  if (localStorage.getItem(SETUP_DONE_KEY)) return;   // already done

  const modal    = document.getElementById('welcome-modal');
  const tzSel    = document.getElementById('welcome-timezone-select');
  const tzLblEl  = document.getElementById('welcome-tz-label');
  const currSel  = document.getElementById('welcome-currency-select');
  const startBtn = document.getElementById('welcome-get-started-btn');

  if (!modal || !tzSel || !startBtn) return;

  // Pre-select the system timezone
  tzSel.value = 'system';
  if (tzLblEl) tzLblEl.textContent = `Detected: ${getSystemTimezone()}`;

  // Update label whenever timezone selection changes
  tzSel.addEventListener('change', () => {
    if (tzLblEl) tzLblEl.textContent = tzSel.value === 'system'
      ? `Detected: ${getSystemTimezone()}`
      : tzLabel(tzSel.value);
  });

  // Show the modal (backdrop already has display:none; remove it)
  modal.style.display = 'flex';

  startBtn.addEventListener('click', () => {
    // Persist timezone
    const chosenTz = tzSel.value || 'system';
    localStorage.setItem(TZ_KEY, chosenTz);

    // Persist currency by updating the prefs selector then calling savePrefs
    const settingsCurrSel = document.getElementById('default-currency');
    if (settingsCurrSel && currSel) settingsCurrSel.value = currSel.value;
    savePrefs();

    // Sync the Settings timezone selector to match
    const settingsTzSel = document.getElementById('timezone-select');
    if (settingsTzSel) {
      settingsTzSel.value = chosenTz;
      updateTimezoneLabel();
    }

    // Mark setup as complete
    localStorage.setItem(SETUP_DONE_KEY, '1');

    // Close modal
    modal.style.display = 'none';
  });
}

// ─── Year Selects ─────────────────────────────────────────────────────────────

/**
 * Populate year-selection dropdowns.
 * The tracker year select is populated separately by initTrackerYearSelect()
 * once the oldest DB record is known.
 */
function initYearSelects() {
  const currentYear = new Date().getFullYear();

  // Tracker year — seed with a minimal fallback range; expanded async by initTrackerYearSelect()
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

/**
 * Async: fetches the year of the oldest upload from SQLite and repopulates the
 * tracker year select so it goes back as far as the user's actual data.
 * Called once on DOMContentLoaded and again after each successful upload.
 */
async function initTrackerYearSelect() {
  const sel = document.getElementById('tracker-year');
  if (!sel) return;

  const currentYear = new Date().getFullYear();
  let oldestYear = currentYear - 4; // fallback if no uploads yet

  try {
    const res = await window.electronAPI.getOldestUploadYear();
    if (res.success && res.data != null) {
      oldestYear = Math.min(res.data, currentYear);
    }
  } catch { /* leave fallback */ }

  // Preserve the currently selected year if possible
  const prevVal = parseInt(sel.value) || currentYear;

  sel.innerHTML = '';
  for (let y = currentYear; y >= oldestYear; y--) {
    const opt = document.createElement('option');
    opt.value       = y;
    opt.textContent = y;
    if (y === (prevVal >= oldestYear ? prevVal : currentYear)) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const PAGE_TITLES = {
  dashboard: 'Dashboard',      import: 'Import Statements',
  tracker:   'Coverage Tracker', history: 'Upload History',
  tax:       'S04 Tax Return', settings: 'Settings',
  account:   'Account Summary',
};

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      navigateTo(view);
      if (view === 'dashboard') refreshDashboard();
      if (view === 'tracker')   refreshTracker();
      if (view === 'history')   refreshHistory();
    });
  });
}

/** Navigate to any view by name (including non-nav views like 'account'). */
function navigateTo(view) {
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(`${view}-view`);
  if (target) target.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[view] || view;
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
    updateSidebarAccountName();   // pull name from DB active account

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

  // Extract meaningful keywords from the parsed account name to use as a
  // tiebreaker when multiple accounts share the same institution and currency.
  // Strip the institution name and account number suffix, then keep words
  // that are meaningful identifiers (e.g. "savings", "checking", "share",
  // "visa", "platinum"). This lets "UNFCU Savings Account ···3462" prefer
  // a LM asset called "UNFCU Savings" over one called "UNFCU Checking".
  const nameKeywords = (() => {
    const raw = (parsed.accountName || '')
      .toLowerCase()
      // remove institution prefix
      .replace(inst, '')
      // remove account number suffixes like ···3462 or (3462)
      .replace(/[·.]{2,}\d+|\(\d+\)/g, '')
      .trim();
    // Keep only words >3 chars that aren't generic noise
    const NOISE = new Set(['account','bank','the','and','for','from','with','ltd','inc']);
    return raw.split(/\s+/).filter(w => w.length > 3 && !NOISE.has(w));
  })();

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

    // ── Account name keyword match ───────────────────────────────────────────
    // Critical tiebreaker for institutions with multiple accounts (e.g. UNFCU
    // Savings vs Checking vs Membership Share). Checks whether descriptive
    // words from the parsed account name appear in the LM asset name.
    // Also checks type-derived synonyms so "chequing" matches "checking".
    const typeSynonyms = {
      chequing:   ['checking','chequing','current'],
      savings:    ['savings','share','membership'],
      credit_card:['credit','visa','mastercard','card'],
    };
    const kwToCheck = [
      ...nameKeywords,
      ...(typeSynonyms[pType] || []),
    ];
    const matchedKws = kwToCheck.filter(kw => aName.includes(kw));
    if (matchedKws.length) {
      // +15 per keyword, capped at +25 so it doesn't overpower account number
      const kwScore = Math.min(25, matchedKws.length * 15);
      score += kwScore;
      reasons.push(`Name keyword matched (${matchedKws.join(', ')})`);
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

  const prefs          = getPrefs();
  let totalUp          = 0;
  const allErrors      = [];
  const processedFiles = new Set();

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

    // Track which queue files are covered by this group
    const sources = [...new Set(group.rows.map(r => r._source))];
    sources.forEach(f => processedFiles.add(f));

    if (result.success && result.data) {
      const uploaded = result.data.uploaded || 0;
      totalUp += uploaded;

      for (const filename of sources) {
        const qItem      = state.queue.find(q => q.name === filename);
        if (!qItem?.parsed) continue;
        const fileTxCount = group.rows.filter(r => r._source === filename).length;

        if (uploaded > 0) {
          // Transactions actually landed in LunchMoney
          await window.electronAPI.saveUpload({
            institution: qItem.parsed.institution,
            accountName: qItem.parsed.accountName,
            accountType: qItem.parsed.accountType,
            currency:    qItem.parsed.currency,
            lmAssetId:   group.assetId || null,
            filename,
            period:      qItem.parsed.period,
            txCount:     fileTxCount,
            lmIds:       result.data.ids,
            status:      'uploaded',
          });
          qItem.status = 'uploaded';
        } else {
          // LunchMoney accepted the request but uploaded 0 — all duplicates / rejected
          const lmErrors = (result.data.errors || []).filter(Boolean).join('; ');
          const skipNote = lmErrors
            ? `No transactions uploaded. LunchMoney error: ${lmErrors}`
            : 'No transactions uploaded — all may be duplicates or were rejected by LunchMoney';
          await window.electronAPI.saveUpload({
            institution: qItem.parsed.institution,
            accountName: qItem.parsed.accountName,
            accountType: qItem.parsed.accountType,
            currency:    qItem.parsed.currency,
            lmAssetId:   group.assetId || null,
            filename,
            period:      qItem.parsed.period,
            txCount:     fileTxCount,
            lmIds:       null,
            status:      'skipped',
            notes:       skipNote,
          });
          qItem.status = 'skipped';
          allErrors.push(`${group.assetName || filename}: ${skipNote}`);
        }
      }
    } else {
      // Request itself failed — log to history and surface the error
      const msg = result.error || (result.data?.errors || []).join(', ') || 'Unknown error';
      allErrors.push(`${group.assetName || 'Upload'}: ${msg}`);

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
          lmIds:       null,
          status:      'failed',
          notes:       msg,
        });
        qItem.status = 'failed';
      }
    }
  }

  btn.disabled  = false;
  btn.innerHTML = '☁️ Upload Selected to LunchMoney';

  // Always close the modal and remove processed files from the queue
  document.getElementById('validate-modal').classList.remove('open');
  state.queue = state.queue.filter(q => !processedFiles.has(q.name));
  renderQueue();
  refreshHistory();
  refreshTracker();
  initTrackerYearSelect();

  if (totalUp > 0) {
    toast(`✓ Uploaded ${totalUp} transaction${totalUp !== 1 ? 's' : ''} to LunchMoney!`, 'success');
  } else if (!allErrors.length) {
    toast('No new transactions were uploaded.', 'info');
  }
  if (allErrors.length) toast(`Upload issues: ${allErrors.join('; ')}`, 'error', 8000);
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

// ─── Exclusion persistence ────────────────────────────────────────────────────
const COVERAGE_EXCLUDED_KEY = 'coverageExcluded';

function getCoverageExcluded() {
  try { return new Set(JSON.parse(localStorage.getItem(COVERAGE_EXCLUDED_KEY) || '[]')); }
  catch { return new Set(); }
}

function setCoverageExcluded(set) {
  localStorage.setItem(COVERAGE_EXCLUDED_KEY, JSON.stringify([...set]));
}

function toggleCoverageExcluded(assetId) {
  const ex = getCoverageExcluded();
  if (ex.has(assetId)) { ex.delete(assetId); } else { ex.add(assetId); }
  setCoverageExcluded(ex);
}

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

  const now       = new Date();
  const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const excluded  = getCoverageExcluded();
  const cards     = [];      // visible cards
  const hiddenCards = [];    // excluded cards (built but hidden by default)

  for (const asset of state.lmAssets) {
    const isExcluded = excluded.has(asset.id);

    let monthData = Array.from({ length: 12 }, (_, i) => ({ month: i+1, year, hasTxns: false, count: 0, earliestDate: null, latestDate: null }));

    if (state.apiKey) {
      const cov = await window.electronAPI.getAssetCoverage({ apiKey: state.apiKey, assetId: asset.id, year });
      if (cov.success) monthData = cov.data;
    }

    // Fetch which months have an uploaded statement in the local DB for this asset.
    // This catches dormant-period statements where the bank sent a statement but
    // recorded zero transactions — LunchMoney has nothing for those months, but
    // they are genuinely covered (statement was reviewed and uploaded).
    let dbCoveredMonths = new Set();
    try {
      const dbMonths = await window.electronAPI.getDbCoverage({ lmAssetId: asset.id, year });
      if (Array.isArray(dbMonths)) dbCoveredMonths = new Set(dbMonths);
    } catch { /* non-fatal — fall back to LM-only coverage */ }

    const cells = monthData.map((m, idx) => {
      const isFuture  = new Date(year, idx, 1) > now;
      const dbCovered = dbCoveredMonths.has(m.month);
      // Priority: future → has LM txns → DB statement uploaded → truly missing
      const cls = isFuture  ? 'future'
                : m.hasTxns ? 'covered'
                : dbCovered ? 'db-covered'
                :             'missing';
      const title = isFuture
        ? `${MONTHS[idx]} ${year} — future`
        : m.hasTxns
          ? `${MONTHS[idx]} ${year} — ${m.count} transaction${m.count !== 1 ? 's' : ''} · ${m.earliestDate} → ${m.latestDate}`
          : dbCovered
            ? `${MONTHS[idx]} ${year} — statement uploaded, no transactions recorded`
            : `${MONTHS[idx]} ${year} — no transactions found`;
      const countLabel = m.hasTxns ? `<span style="font-size:9px;color:var(--accent2);">${m.count}</span>` : '';
      return `<div class="month-cell ${cls}" title="${title}">${MONTHS[idx]}${countLabel}</div>`;
    }).join('');

    // A month is only "missing" if it has neither LM transactions nor a DB-uploaded statement
    const missingIdxs  = monthData.reduce((acc, m, i) =>
      (!m.hasTxns && !dbCoveredMonths.has(m.month) && new Date(year, i, 1) <= now ? [...acc, i] : acc), []);
    const coveredCount = monthData.filter((m, i) => m.hasTxns || dbCoveredMonths.has(m.month)).length;
    const maxMonth     = now.getFullYear() === year ? now.getMonth() + 1 : 12;

    const card   = document.createElement('div');
    card.className = 'card' + (isExcluded ? ' tracker-card-excluded' : '');
    card.dataset.assetId = asset.id;
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
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          ${isExcluded
            ? `<span class="badge badge-gray" style="flex-shrink:0;">Hidden</span>`
            : missingIdxs.length > 0
              ? `<span class="badge badge-red">⚠ ${missingIdxs.length} month${missingIdxs.length!==1?'s':''} missing</span>`
              : `<span class="badge badge-green">✓ ${coveredCount}/${maxMonth} months</span>`}
          <button class="btn btn-ghost btn-xs tracker-exclude-btn"
                  data-asset-id="${asset.id}"
                  title="${isExcluded ? 'Add back to coverage tracker' : 'Exclude from coverage tracker'}"
                  style="padding:2px 7px;font-size:11px;opacity:0.7;">
            ${isExcluded ? '＋ Track' : '− Exclude'}
          </button>
        </div>
      </div>
      ${isExcluded ? '' : `
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
        ${year} coverage · Live from LunchMoney · Overlapping periods handled per transaction date
      </div>
      <div class="coverage-grid">${cells}</div>
      ${missingIdxs.length > 0
        ? `<div style="margin-top:8px;font-size:12px;color:var(--warn);">
             Missing: ${missingIdxs.slice(0,6).map(i => `${MONTHS[i]} ${year}`).join(', ')}${missingIdxs.length>6?' + '+(missingIdxs.length-6)+' more':''}
           </div>`
        : ''}
      `}
    `;

    // Wire the exclude/include button
    card.querySelector('.tracker-exclude-btn').addEventListener('click', () => {
      toggleCoverageExcluded(asset.id);
      refreshTracker();
    });

    if (isExcluded) { hiddenCards.push(card); } else { cards.push(card); }
  }

  container.innerHTML = '';
  cards.forEach(c => container.appendChild(c));

  // Hidden-accounts bar
  if (hiddenCards.length > 0) {
    const bar = document.createElement('div');
    bar.id = 'tracker-hidden-bar';
    bar.style.cssText = 'margin-top:12px;padding:10px 14px;border-radius:8px;background:var(--surface2);display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-muted);';
    bar.innerHTML = `
      <span style="flex:1;">${hiddenCards.length} account${hiddenCards.length!==1?'s':''} hidden from coverage tracker</span>
      <button class="btn btn-secondary btn-sm" id="tracker-show-hidden-btn">Show</button>
    `;
    container.appendChild(bar);

    bar.querySelector('#tracker-show-hidden-btn').addEventListener('click', () => {
      hiddenCards.forEach(c => container.insertBefore(c, bar));
      bar.querySelector('#tracker-show-hidden-btn').style.display = 'none';
      bar.querySelector('span').textContent = `${hiddenCards.length} hidden account${hiddenCards.length!==1?'s':''} shown above`;
    });
  }

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

  // Store in a map for quick lookup when a row is clicked
  state.uploadMap = {};
  uploads.forEach(u => { state.uploadMap[u.id] = u; });

  tbody.innerHTML = uploads.map(u => {
    const badgeCls = u.status === 'uploaded' ? 'badge-green' : u.status === 'failed' ? 'badge-red' : 'badge-yellow';
    const hasNote  = u.notes ? ' title="Click for details"' : '';
    return `
      <tr data-upload-id="${u.id}" style="cursor:pointer;" class="history-row"${hasNote}>
        <td style="color:var(--text-muted);font-size:12px;">${fmtUploadTime(u.uploaded_at)}</td>
        <td>${escHtml(u.institution||'')}</td>
        <td>${escHtml(u.account_name||'')}</td>
        <td style="font-size:12px;">${u.period_start?u.period_start.slice(0,7):'—'} ${u.period_end&&u.period_end!==u.period_start?'→ '+u.period_end.slice(0,7):''}</td>
        <td>${u.tx_count||0}</td>
        <td><span class="badge ${badgeCls}">${u.status||'unknown'}</span>${u.notes?'<span style="margin-left:6px;font-size:10px;color:var(--text-muted);">ⓘ</span>':''}</td>
      </tr>
    `;
  }).join('');
}

function showUploadDetail(u) {
  const body = document.getElementById('upload-detail-body');
  const badgeCls = u.status === 'uploaded' ? 'badge-green' : u.status === 'failed' ? 'badge-red' : 'badge-yellow';

  let lmIds = null;
  try { lmIds = JSON.parse(u.lm_ids || 'null'); } catch { /* ignore */ }

  const isError = u.status === 'failed' || u.status === 'skipped';

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:130px 1fr;gap:8px 16px;font-size:13px;margin-bottom:16px;">
      <span style="color:var(--text-muted);">Status</span>
      <span><span class="badge ${badgeCls}">${u.status || 'unknown'}</span></span>

      <span style="color:var(--text-muted);">Date</span>
      <span>${fmtUploadTime(u.uploaded_at)}</span>

      <span style="color:var(--text-muted);">Institution</span>
      <span>${escHtml(u.institution || '—')}</span>

      <span style="color:var(--text-muted);">Account</span>
      <span>${escHtml(u.account_name || '—')}</span>

      <span style="color:var(--text-muted);">File</span>
      <span style="word-break:break-all;font-size:12px;color:var(--text-muted);">${escHtml(u.filename || '—')}</span>

      <span style="color:var(--text-muted);">Period</span>
      <span>${u.period_start ? u.period_start.slice(0,7) : '—'}${u.period_end && u.period_end !== u.period_start ? ' → ' + u.period_end.slice(0,7) : ''}</span>

      <span style="color:var(--text-muted);">Transactions</span>
      <span>${u.tx_count || 0}</span>

      ${lmIds && lmIds.length ? `
        <span style="color:var(--text-muted);">LM IDs</span>
        <span style="font-size:11px;color:var(--text-muted);">
          ${lmIds.slice(0,12).join(', ')}${lmIds.length > 12 ? ` + ${lmIds.length - 12} more` : ''}
        </span>
      ` : ''}
    </div>

    ${u.notes ? `
      <div style="font-size:12px;font-weight:600;color:${isError ? 'var(--warn)' : 'var(--text-muted)'};margin-bottom:6px;">
        ${isError ? '⚠ Error Details' : 'Notes'}
      </div>
      <pre style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:12px;
                  font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0;
                  max-height:200px;overflow-y:auto;color:${isError ? 'var(--warn)' : 'inherit'};">
${escHtml(u.notes)}</pre>
    ` : ''}
  `;

  // Show copy button only when there are notes to copy
  const copyBtn = document.getElementById('upload-detail-copy');
  if (u.notes) {
    copyBtn.style.display = '';
    copyBtn.textContent = '📋 Copy Errors';
    copyBtn._notesText = u.notes;
  } else {
    copyBtn.style.display = 'none';
    copyBtn._notesText = '';
  }

  document.getElementById('upload-detail-modal').classList.add('open');
}

// Wire history row clicks and upload-detail close (called once after DOM ready)
function setupHistoryDetailModal() {
  const tbody = document.getElementById('history-tbody');
  tbody.addEventListener('click', e => {
    const row = e.target.closest('tr[data-upload-id]');
    if (!row) return;
    const u = state.uploadMap?.[row.dataset.uploadId];
    if (u) showUploadDetail(u);
  });

  document.getElementById('upload-detail-close').addEventListener('click', () => {
    document.getElementById('upload-detail-modal').classList.remove('open');
  });

  document.getElementById('upload-detail-copy').addEventListener('click', async function () {
    const text = this._notesText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.textContent = '✓ Copied!';
      setTimeout(() => { this.textContent = '📋 Copy Errors'; }, 2000);
    } catch {
      toast('Could not copy to clipboard', 'error');
    }
  });
  document.getElementById('upload-detail-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function setupSettings() {
  // ── Add LunchMoney account ───────────────────────────────────────────────
  document.getElementById('add-account-btn').addEventListener('click', addLMAccount);
  document.getElementById('new-account-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') addLMAccount();
  });

  // ── Legacy single-key fallback (hidden once accounts exist) ─────────────
  const saveApiBtn = document.getElementById('save-api-key-btn');
  const testApiBtn = document.getElementById('test-api-btn');
  if (saveApiBtn) {
    saveApiBtn.addEventListener('click', async () => {
      const key = document.getElementById('api-key-input').value.trim();
      if (!key) { toast('Please enter an API key', 'error'); return; }
      localStorage.setItem('lm_api_key', key);
      await connectAPI(key, true);
    });
  }
  if (testApiBtn) {
    testApiBtn.addEventListener('click', async () => {
      const key = document.getElementById('api-key-input').value.trim();
      if (!key) { toast('Enter an API key first', 'error'); return; }
      await connectAPI(key, true);
    });
  }

  document.getElementById('save-prefs-btn').addEventListener('click', savePrefs);

  // ── Taxpayer profile ────────────────────────────────────────────────────
  document.getElementById('save-profile-btn').addEventListener('click', saveProfile);

  // ── TAJ Portal shortcut ─────────────────────────────────────────────────
  const tajBtn = document.getElementById('open-taj-btn');
  if (tajBtn) {
    tajBtn.addEventListener('click', e => {
      e.preventDefault();
      require('electron').shell.openExternal('https://mytaxes.ads.taj.gov.jm/_/');
    });
  }

  // ── Category → Tax mapping panel ────────────────────────────────────────
  const toggleArea = document.getElementById('cat-map-toggle');
  const toggleBtn  = document.getElementById('cat-map-toggle-btn');
  const panel      = document.getElementById('cat-map-panel');
  if (toggleArea && panel) {
    toggleArea.addEventListener('click', e => {
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
}

// ─── Taxpayer Profile ─────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
//  LUNCHMONEY MULTI-ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/** Render the saved-accounts list in Settings. */
async function renderLMAccountsList() {
  const el = document.getElementById('lm-accounts-list');
  if (!el) return;

  const res = await window.electronAPI.lmAccounts.list();
  const accounts = res?.data || [];

  if (!accounts.length) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:4px 0 12px;">
      No accounts saved yet. Add one below.
    </div>`;
    return;
  }

  el.innerHTML = accounts.map(acc => {
    const initials = (acc.user_name || acc.label || '?')
      .split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const meta = [acc.user_name, acc.budget_name].filter(Boolean).join(' · ') || 'LunchMoney account';
    return `<div class="lm-account-row ${acc.is_active ? 'active' : ''}" data-id="${acc.id}">
      <div class="lm-account-avatar">${escHtml(initials)}</div>
      <div class="lm-account-info">
        <div class="lm-account-label">${escHtml(acc.label)}</div>
        <div class="lm-account-meta">${escHtml(meta)}</div>
      </div>
      ${acc.is_active
        ? `<span class="lm-account-active-badge">Active</span>`
        : `<button class="btn btn-secondary btn-sm lm-switch-btn" data-id="${acc.id}" style="font-size:11px;padding:3px 10px;">Switch</button>`}
      <button class="btn btn-danger btn-sm lm-remove-btn" data-id="${acc.id}" style="font-size:11px;padding:3px 8px;" title="Remove account">✕</button>
    </div>`;
  }).join('');

  // Wire switch buttons
  el.querySelectorAll('.lm-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => switchLMAccount(parseInt(btn.dataset.id)));
  });
  // Wire remove buttons
  el.querySelectorAll('.lm-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeLMAccount(parseInt(btn.dataset.id)));
  });
}

/** Connect & save a new LunchMoney account from the Settings form. */
async function addLMAccount() {
  const keyInput    = document.getElementById('new-account-key');
  const labelInput  = document.getElementById('new-account-label');
  const statusEl    = document.getElementById('add-account-status');
  const btn         = document.getElementById('add-account-btn');

  const apiKey = keyInput?.value.trim();
  const label  = labelInput?.value.trim();

  if (!apiKey) { toast('Please paste an API key', 'error'); return; }

  btn.disabled     = true;
  btn.textContent  = 'Connecting…';
  if (statusEl) statusEl.textContent = '';

  const res = await window.electronAPI.lmAccounts.add({ label, apiKey });

  btn.disabled    = false;
  btn.textContent = 'Connect & Save';

  if (!res.success) {
    if (statusEl) statusEl.textContent = `✗ ${res.error}`;
    toast(`Failed to connect: ${res.error}`, 'error');
    return;
  }

  // Clear form
  if (keyInput)   keyInput.value   = '';
  if (labelInput) labelInput.value = '';
  if (statusEl)   statusEl.textContent = '✓ Connected';
  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);

  // Switch to the new account
  state.apiKey = apiKey;
  localStorage.setItem('lm_api_key', apiKey);
  await connectAPI(apiKey, false);
  renderLMAccountsList();
  toast(`Account added: ${res.data.userName || res.data.budgetName || label || 'new account'}`, 'success');
}

/** Switch to a different saved LunchMoney account. */
async function switchLMAccount(id) {
  const res = await window.electronAPI.lmAccounts.switch(id);
  if (!res.success) { toast(`Switch failed: ${res.error}`, 'error'); return; }

  const newKey = res.data?.api_key;
  if (!newKey) { toast('Could not read API key for this account', 'error'); return; }

  state.apiKey = newKey;
  localStorage.setItem('lm_api_key', newKey);

  const legacyInput = document.getElementById('api-key-input');
  if (legacyInput) legacyInput.value = newKey;

  await connectAPI(newKey, false);
  renderLMAccountsList();
  refreshDashboard();
  refreshTracker();
  closeSidebarSwitcher();
  toast(`Switched to ${res.data.user_name || res.data.label || 'account'}`, 'success');
}

/** Remove a saved account (prompts if it's the active one). */
async function removeLMAccount(id) {
  const res = await window.electronAPI.lmAccounts.remove(id);
  if (!res.success) { toast(`Remove failed: ${res.error}`, 'error'); return; }

  // If a new active account was returned, switch to it; else clear connection
  const newActive = res.data;
  if (newActive?.api_key) {
    state.apiKey = newActive.api_key;
    localStorage.setItem('lm_api_key', newActive.api_key);
    await connectAPI(newActive.api_key, false);
  } else {
    state.apiKey = null;
    localStorage.removeItem('lm_api_key');
    const dot   = document.getElementById('api-dot');
    const label = document.getElementById('api-label');
    if (dot)   dot.className     = 'status-dot';
    if (label) label.textContent = 'Not connected';
    updateSidebarAccountName();
  }

  renderLMAccountsList();
  toast('Account removed.', 'info');
}

/** Pull the active account's user/budget name from DB and update the sidebar. */
async function updateSidebarAccountName() {
  const block  = document.getElementById('sidebar-account-block');
  const nameEl = document.getElementById('sidebar-account-name');
  const budgEl = document.getElementById('sidebar-account-budget');
  if (!block) return;

  const res = await window.electronAPI.lmAccounts.getActive();
  const acc  = res?.data;

  if (acc && (acc.user_name || acc.budget_name || acc.label)) {
    nameEl.textContent = acc.user_name || acc.label;
    budgEl.textContent = acc.budget_name && acc.budget_name !== acc.user_name
      ? acc.budget_name : '';
    block.style.display = 'block';
  } else {
    block.style.display = 'none';
    closeSidebarSwitcher();
  }
}

/** Set up the sidebar account-switcher popover (called once on DOMContentLoaded). */
function setupSidebarAccountSwitcher() {
  const block   = document.getElementById('sidebar-account-block');
  const popover = document.getElementById('account-switcher-popover');
  if (!block || !popover) return;

  // Toggle popover on block click
  block.addEventListener('click', async () => {
    const isOpen = popover.style.display !== 'none';
    if (isOpen) {
      closeSidebarSwitcher();
    } else {
      await openSidebarSwitcher();
    }
  });

  // Close when clicking anywhere outside the sidebar
  document.addEventListener('click', e => {
    if (!block.contains(e.target) && !popover.contains(e.target)) {
      closeSidebarSwitcher();
    }
  }, true);
}

async function openSidebarSwitcher() {
  const block   = document.getElementById('sidebar-account-block');
  const popover = document.getElementById('account-switcher-popover');
  const list    = document.getElementById('account-switcher-list');

  const res      = await window.electronAPI.lmAccounts.list();
  const accounts = res?.data || [];

  if (accounts.length <= 1) {
    // Only one account — navigate to Settings instead of showing a one-item list
    closeSidebarSwitcher();
    navigateTo('settings');
    return;
  }

  list.innerHTML = accounts.map(acc => {
    const initials = (acc.user_name || acc.label || '?')
      .split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const label = acc.label || acc.user_name || 'Account';
    const meta  = acc.budget_name && acc.budget_name !== acc.user_name
      ? acc.budget_name : acc.user_name || '';
    return `
      <div class="switcher-row ${acc.is_active ? 'active' : ''}" data-id="${acc.id}">
        <div class="switcher-avatar">${escHtml(initials)}</div>
        <div class="switcher-info">
          <div class="switcher-label">${escHtml(label)}</div>
          ${meta ? `<div class="switcher-meta">${escHtml(meta)}</div>` : ''}
        </div>
        ${acc.is_active ? '<span class="switcher-check">✓</span>' : ''}
      </div>`;
  }).join('');

  // Wire row clicks
  list.querySelectorAll('.switcher-row').forEach(row => {
    row.addEventListener('click', async () => {
      const id = parseInt(row.dataset.id);
      const active = row.classList.contains('active');
      closeSidebarSwitcher();
      if (!active) await switchLMAccount(id);
    });
  });

  popover.style.display = 'block';
  block.classList.add('switcher-open');
}

function closeSidebarSwitcher() {
  const block   = document.getElementById('sidebar-account-block');
  const popover = document.getElementById('account-switcher-popover');
  if (popover) popover.style.display = 'none';
  if (block)   block.classList.remove('switcher-open');
}

// ─── Taxpayer Profile ─────────────────────────────────────────────────────────

const PROFILE_KEY = 'lm_taxpayer_profile';

function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); }
  catch { return {}; }
}

function saveProfile() {
  const profile = {
    fullName:     document.getElementById('profile-name')?.value.trim()     || '',
    trn:          document.getElementById('profile-trn')?.value.trim()      || '',
    businessName: document.getElementById('profile-business')?.value.trim() || '',
    address:      document.getElementById('profile-address')?.value.trim()  || '',
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  toast('Taxpayer profile saved.', 'success');
}

function restoreProfile() {
  const p = getProfile();
  const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
  set('profile-name',     p.fullName);
  set('profile-trn',      p.trn);
  set('profile-business', p.businessName);
  set('profile-address',  p.address);
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

  // Timezone is stored separately so it's always accessible without loading full prefs
  const tzSel = document.getElementById('timezone-select');
  if (tzSel) localStorage.setItem(TZ_KEY, tzSel.value);

  toast('Preferences saved', 'success');
}
function restorePrefs() {
  const p = state.prefs;
  if (p.defaultCurrency) document.getElementById('default-currency').value = p.defaultCurrency;
  if (p.skipDuplicates != null) document.getElementById('skip-duplicates').checked = p.skipDuplicates;
  if (p.applyRules      != null) document.getElementById('apply-rules').checked     = p.applyRules;

  // Restore timezone selector and live label
  const tzSel = document.getElementById('timezone-select');
  if (tzSel) {
    tzSel.value = getAppTimezone();
    updateTimezoneLabel();
    tzSel.addEventListener('change', updateTimezoneLabel);
  }
}

/** Updates the descriptive label shown below the timezone <select> in Settings. */
function updateTimezoneLabel() {
  const tzSel  = document.getElementById('timezone-select');
  const lbl    = document.getElementById('timezone-current-label');
  if (!tzSel || !lbl) return;
  lbl.textContent = `Current: ${tzLabel(tzSel.value)}`;
}

// ─── S04 Tax ──────────────────────────────────────────────────────────────────

function setupTaxView() {
  document.getElementById('generate-tax-btn').addEventListener('click', generateTax);

  // ── S04A button ────────────────────────────────────────────────────────
  const s04aBtn = document.getElementById('generate-s04a-btn');
  if (s04aBtn) s04aBtn.addEventListener('click', generateS04AEstimate);

  // ── Filing history refresh ─────────────────────────────────────────────
  const refreshFilingsBtn = document.getElementById('refresh-filings-btn');
  if (refreshFilingsBtn) refreshFilingsBtn.addEventListener('click', refreshFilingHistory);

  // ── P24 ────────────────────────────────────────────────────────────────
  setupP24();
}

// ─── P24 Employment Income ────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function setupP24() {
  // Sync P24 table when tax year changes
  const taxYearSel = document.getElementById('tax-year-select');
  taxYearSel.addEventListener('change', () => loadP24Entries(parseInt(taxYearSel.value)));

  // Add button
  document.getElementById('p24-add-btn').addEventListener('click', () => openP24Modal());

  // Modal cancel / backdrop
  document.getElementById('p24-modal-cancel').addEventListener('click', closeP24Modal);
  document.getElementById('p24-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeP24Modal();
  });

  // Modal save
  document.getElementById('p24-modal-save').addEventListener('click', saveP24Entry);

  // Load entries for the current year once the view initialises
  const initialYear = parseInt(taxYearSel.value) || new Date().getFullYear() - 1;
  loadP24Entries(initialYear);
}

async function loadP24Entries(year) {
  const result = await window.electronAPI.p24.getForYear(year);
  if (!result.success) { console.error('P24 load error:', result.error); return; }

  const entries = result.data || [];
  const tbody   = document.getElementById('p24-tbody');
  const tfoot   = document.getElementById('p24-tfoot');
  const table   = document.getElementById('p24-table');
  const empty   = document.getElementById('p24-empty');
  const fmt     = v => `$${Number(v||0).toLocaleString('en-JM',{minimumFractionDigits:2})}`;

  if (!entries.length) {
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';

  // Body rows
  tbody.innerHTML = entries.map(e => `
    <tr data-p24-id="${e.id}">
      <td>${MONTH_NAMES[(e.month || 1) - 1]} ${e.year}</td>
      <td>${escHtml(e.employer_name)}</td>
      <td style="text-align:right;">${fmt(e.gross_emoluments)}</td>
      <td style="text-align:right;">${fmt(e.nis_deducted)}</td>
      <td style="text-align:right;">${fmt(e.nht_deducted)}</td>
      <td style="text-align:right;">${fmt(e.ed_tax_deducted)}</td>
      <td style="text-align:right;">${fmt(e.paye_deducted)}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="openP24Modal(${e.id})" style="padding:2px 8px;font-size:11px;">Edit</button>
        <button class="btn btn-sm" style="padding:2px 8px;font-size:11px;background:var(--warn);color:#fff;border:none;" onclick="deleteP24Entry(${e.id})">✕</button>
      </td>
    </tr>
  `).join('');

  // Footer totals
  const totals = entries.reduce((acc, e) => {
    acc.gross += e.gross_emoluments || 0;
    acc.nis   += e.nis_deducted     || 0;
    acc.nht   += e.nht_deducted     || 0;
    acc.ed    += e.ed_tax_deducted  || 0;
    acc.paye  += e.paye_deducted    || 0;
    return acc;
  }, { gross: 0, nis: 0, nht: 0, ed: 0, paye: 0 });

  tfoot.innerHTML = `
    <tr style="font-weight:700;border-top:2px solid var(--border);">
      <td colspan="2" style="color:var(--text-muted);font-size:12px;">TOTALS (${entries.length} entr${entries.length !== 1 ? 'ies' : 'y'})</td>
      <td style="text-align:right;">${fmt(totals.gross)}</td>
      <td style="text-align:right;">${fmt(totals.nis)}</td>
      <td style="text-align:right;">${fmt(totals.nht)}</td>
      <td style="text-align:right;">${fmt(totals.ed)}</td>
      <td style="text-align:right;">${fmt(totals.paye)}</td>
      <td></td>
    </tr>
  `;

  // Store raw entries on state for reference
  state.p24Entries = entries;
}

function openP24Modal(id) {
  const modal    = document.getElementById('p24-modal');
  const title    = document.getElementById('p24-modal-title');
  const taxYear  = parseInt(document.getElementById('tax-year-select').value) || new Date().getFullYear() - 1;

  // Clear form
  document.getElementById('p24-entry-id').value      = '';
  document.getElementById('p24-year').value          = taxYear;
  document.getElementById('p24-month').value         = '1';
  document.getElementById('p24-employer-name').value = '';
  document.getElementById('p24-employer-trn').value  = '';
  document.getElementById('p24-gross').value         = '';
  document.getElementById('p24-nis').value           = '';
  document.getElementById('p24-nht').value           = '';
  document.getElementById('p24-edtax').value         = '';
  document.getElementById('p24-paye').value          = '';
  document.getElementById('p24-net').value           = '';
  document.getElementById('p24-notes').value         = '';

  if (id) {
    // Populate with existing entry
    const entry = (state.p24Entries || []).find(e => e.id === id);
    if (entry) {
      title.textContent = '🧾 Edit P24 Entry';
      document.getElementById('p24-entry-id').value      = entry.id;
      document.getElementById('p24-year').value          = entry.year;
      document.getElementById('p24-month').value         = entry.month;
      document.getElementById('p24-employer-name').value = entry.employer_name;
      document.getElementById('p24-employer-trn').value  = entry.employer_trn || '';
      document.getElementById('p24-gross').value         = entry.gross_emoluments || '';
      document.getElementById('p24-nis').value           = entry.nis_deducted     || '';
      document.getElementById('p24-nht').value           = entry.nht_deducted     || '';
      document.getElementById('p24-edtax').value         = entry.ed_tax_deducted  || '';
      document.getElementById('p24-paye').value          = entry.paye_deducted    || '';
      document.getElementById('p24-net').value           = entry.net_pay          || '';
      document.getElementById('p24-notes').value         = entry.notes            || '';
    }
  } else {
    title.textContent = '🧾 Add P24 Entry';
  }

  modal.classList.add('open');
}

function closeP24Modal() {
  document.getElementById('p24-modal').classList.remove('open');
}

async function saveP24Entry() {
  const employerName = document.getElementById('p24-employer-name').value.trim();
  const year         = parseInt(document.getElementById('p24-year').value);
  const month        = parseInt(document.getElementById('p24-month').value);

  if (!employerName) { toast('Employer name is required', 'error'); return; }
  if (!year || year < 2000 || year > 2099) { toast('Enter a valid tax year', 'error'); return; }

  const id = document.getElementById('p24-entry-id').value;

  const payload = {
    id:               id ? parseInt(id) : undefined,
    year,
    month,
    employerName,
    employerTrn:      document.getElementById('p24-employer-trn').value.trim() || null,
    grossEmoluments:  parseFloat(document.getElementById('p24-gross').value)  || 0,
    nisDeducted:      parseFloat(document.getElementById('p24-nis').value)    || 0,
    nhtDeducted:      parseFloat(document.getElementById('p24-nht').value)    || 0,
    edTaxDeducted:    parseFloat(document.getElementById('p24-edtax').value)  || 0,
    payeDeducted:     parseFloat(document.getElementById('p24-paye').value)   || 0,
    netPay:           parseFloat(document.getElementById('p24-net').value)    || 0,
    notes:            document.getElementById('p24-notes').value.trim() || null,
  };

  const result = await window.electronAPI.p24.save(payload);
  if (!result.success) { toast(`Failed to save P24 entry: ${result.error}`, 'error'); return; }

  closeP24Modal();
  toast(id ? 'P24 entry updated' : 'P24 entry added', 'success');
  loadP24Entries(year);
}

async function deleteP24Entry(id) {
  if (!confirm('Delete this P24 entry?')) return;
  const result = await window.electronAPI.p24.delete(id);
  if (!result.success) { toast(`Failed to delete: ${result.error}`, 'error'); return; }
  toast('P24 entry deleted', 'info');
  const year = parseInt(document.getElementById('tax-year-select').value);
  loadP24Entries(year);
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
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:18px;font-weight:700;">S04 — Self Employed Income Tax Return</div>
          <div style="font-size:13px;color:var(--text-muted);">Tax Year: ${report.year}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="badge badge-blue">ESTIMATE ONLY</span>
          <button class="btn btn-secondary btn-sm" id="show-field-map-btn">📋 TAJ Field Guide</button>
          <button class="btn btn-secondary btn-sm" id="export-pdf-btn">📄 Export PDF</button>
        </div>
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
        ${report.p24 ? `<div class="tax-row"><span>Employment Income <span class="badge badge-blue" style="font-size:10px;vertical-align:middle;">P24 — ${report.p24.entryCount} entr${report.p24.entryCount !== 1 ? 'ies' : 'y'}</span></span><span class="tax-amount">${fmt(report.income.employmentIncome)}</span></div>` : ''}
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
      ${report.p24 ? `
      <div class="tax-section">
        <div class="card-title">Part E — P24 Withholdings (Already Paid via PAYE)</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          Taxes deducted by your employer and already remitted to TAJ. These are credited against your S04 liability above.
        </div>
        <div class="tax-row"><span>NIS withheld by employer</span><span class="tax-amount" style="color:var(--accent2);">− ${fmt(report.p24.nisDeducted)}</span></div>
        <div class="tax-row"><span>NHT withheld by employer</span><span class="tax-amount" style="color:var(--accent2);">− ${fmt(report.p24.nhtDeducted)}</span></div>
        <div class="tax-row"><span>Education Tax withheld</span><span class="tax-amount" style="color:var(--accent2);">− ${fmt(report.p24.edTaxDeducted)}</span></div>
        <div class="tax-row"><span>PAYE Income Tax withheld</span><span class="tax-amount" style="color:var(--accent2);">− ${fmt(report.p24.payeDeducted)}</span></div>
        <div class="tax-row tax-row-total"><strong>Total P24 Credit</strong><span class="tax-amount" style="color:var(--accent2);">− ${fmt(report.p24.totalWithheld)}</span></div>
      </div>` : ''}
      <div style="background:var(--surface2);border-radius:8px;padding:16px;margin:16px 0;">
        ${report.p24 ? `
        <div class="tax-row" style="border:none;font-size:13px;color:var(--text-muted);padding-bottom:6px;">
          <span>Gross Tax Liability (before P24 credits)</span>
          <span>${fmt(report.p24.totalGrossLiability)}</span>
        </div>
        <div class="tax-row" style="border:none;font-size:13px;color:var(--accent2);padding-bottom:10px;">
          <span>Less: P24 Withholdings</span>
          <span>− ${fmt(report.p24.totalWithheld)}</span>
        </div>` : ''}
        <div class="tax-row" style="border:none;font-size:16px;font-weight:700;">
          <span>Additional Tax Payable on S04</span>
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

  // ── TAJ Field Guide card (injected after report card) ───────────────────
  const fieldMapCard = buildFieldMappingCard(report);
  wrap.appendChild(fieldMapCard);

  // Toggle field map card
  document.getElementById('show-field-map-btn').addEventListener('click', () => {
    const open = fieldMapCard.style.display !== 'none';
    fieldMapCard.style.display = open ? 'none' : 'block';
    document.getElementById('show-field-map-btn').textContent = open ? '📋 TAJ Field Guide' : '▲ Hide Guide';
    if (!open) fieldMapCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Export PDF button
  document.getElementById('export-pdf-btn').addEventListener('click', () => exportS04PDF(report));
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
    return `<div class="dash-balance-card" data-asset-id="${a.id}" style="cursor:pointer;" title="Click to view account summary">
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

  // Wire click → account summary view
  el.querySelectorAll('.dash-balance-card[data-asset-id]').forEach(card => {
    card.addEventListener('click', () => {
      const assetId = parseInt(card.dataset.assetId);
      const asset   = assets.find(a => a.id === assetId);
      if (asset) showAccountView(asset);
    });
  });
}

function renderDashboardMissing(trackerAccounts, qLabel) {
  const el = document.getElementById('dash-missing');

  // Filter out accounts the user has excluded from the coverage tracker
  const excluded = getCoverageExcluded();
  const activeAccounts = trackerAccounts.filter(a => !excluded.has(a.id));

  if (!activeAccounts.length) {
    el.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:4px 0;">
      No uploaded accounts tracked yet. Upload statements to start tracking coverage.
    </div>`;
    return;
  }

  const withMissing    = activeAccounts.filter(a => a.quarterMissing.length > 0);
  const withoutMissing = activeAccounts.filter(a => a.quarterMissing.length === 0);
  const hiddenCount    = trackerAccounts.length - activeAccounts.length;

  if (!withMissing.length) {
    const hiddenNote = hiddenCount > 0
      ? `<span style="font-size:11px;color:var(--text-muted);margin-left:6px;">(${hiddenCount} excluded)</span>`
      : '';
    el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;color:var(--accent2);font-size:13px;padding:4px 0;">
      <span style="font-size:20px;">✓</span>
      <span>All ${activeAccounts.length} tracked account${activeAccounts.length !== 1 ? 's' : ''} have statements for ${qLabel}.${hiddenNote}</span>
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

  const hiddenRow = hiddenCount > 0
    ? `<div style="font-size:11px;color:var(--text-muted);padding:6px 0 2px;">${hiddenCount} account${hiddenCount!==1?'s':''} excluded from tracker — manage in Coverage Tracker view.</div>`
    : '';

  el.innerHTML = warningRows + okRows + hiddenRow;
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

/**
 * Formats a SQLite-stored UTC timestamp (e.g. "2024-01-15 14:30:00" or
 * "2024-01-15T14:30:00") into the user's configured local timezone.
 * Returns "YYYY-MM-DD HH:MM" in local time so past records are also corrected.
 */
function fmtUploadTime(utcStr) {
  if (!utcStr) return '—';
  // SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS" with no tz suffix.
  // Replace the space separator and append Z so Date() treats it as UTC.
  const iso = utcStr.trim().replace(' ', 'T').replace(/(\.\d+)?$/, 'Z');
  const d   = new Date(iso);
  if (isNaN(d)) return utcStr.slice(0, 16).replace('T', ' ');

  const tz = getAppTimezone();
  const resolved = tz === 'system' ? getSystemTimezone() : tz;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: resolved,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = t => parts.find(p => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return utcStr.slice(0, 16).replace('T', ' ');
  }
}

function toast(message, type = 'info', duration = 4000) {
  const el = document.createElement('div');
  el.className   = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACCOUNT SUMMARY VIEW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Payee Detection + Suggestion (renderer-side mirror of src/payee-detect.js) ─

const PAYEE_LEADING_PREFIXES = [
  /^Point\s+Of\s+Sale\s+Withdrawal\s+/i,
  /^ATM\s+Withdrawal\s+/i,
  /^IAT\s+(Deposit|Withdrawal)\s+/i,
  /^External\s+(Deposit|Withdrawal)\s+/i,
  /^(Deposit|Withdrawal)\s+Digital\s+Transfer\s+(from|to)\s+\S+\s+(SAV|CK|CHK)\s*/i,
  /^(Deposit|Withdrawal)\s+/i,
  /^FX\s+International\s+Fee\s+Non\s+US\s+Funds\s*/i,
  /^Credit\s+Interest\s*/i,
  /^Service\s+Charge\s*/i,
  /^Excessive\s+Transaction\s+Fee\s*/i,
  /^ACH\s+/i,
  /^WIRE\s+/i,
  /^MercuryACH\s+.*?\s+From\s+/i,
  /\s+via\s+mercury\.com\s*$/i,
];

const PAYEE_TRAILING_NOISE = [
  /\b[A-Z]{2}\s+[A-Z]{2}\s*$/,
  /\b(Kingston|St\.?\s*Andrew|St\.?\s*James|Montego\s*Bay|Portmore|Spanish\s*Town|Liguanea|Barbican|Manor\s*Park|Half\s*Way\s*Tree|Cross\s*Roads|New\s*Kingston|Mona)\s*\d*\s*(JM|Jamaica)?\s*$/i,
  /\s*\b\d{3}-\d{3}-\d{4}\b\s*/g,
  /\s+(JM|Jamaica|CA|US|GB|UK)\s*$/i,
];

const PAYEE_ACRONYMS = new Set(['ATM','BNS','NCB','JN','ACH','FX','IAT','NHT','NIS','TAJ',
  'KFC','BMW','LLC','INC','LTD','PLC','CO']);

function payeeTitleCase(str) {
  return str.replace(/\S+/g, w => {
    if (PAYEE_ACRONYMS.has(w.toUpperCase())) return w.toUpperCase();
    if (/^\d/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

function isRawBankText(str) {
  if (!str || str.length < 4) return false;
  const letters = str.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 4 && str.replace(/[^A-Z]/g, '').length / letters.length > 0.7) return true;
  if (/^(Point\s+Of\s+Sale|ATM\s+Withdrawal|IAT\s+(Deposit|Withdrawal)|External\s+(Deposit|Withdrawal)|ACH\s+|WIRE\s+|FX\s+International|Deposit\s+Digital|Withdrawal\s+Digital|Credit\s+Interest|Service\s+Charge|Excessive\s+Transaction)/i.test(str)) return true;
  if (/\b\d{3}-\d{3}-\d{4}\b/.test(str)) return true;
  if (/\b[A-Z]{2}\s+[A-Z]{2}\s*$/.test(str)) return true;
  return false;
}

function needsPayeeCleanup(tx) {
  const payee = (tx.payee || '').trim();
  const orig  = (tx.original_name || '').trim();
  if (!payee) return true;
  if (payee === orig && isRawBankText(payee)) return true;
  return false;
}

function suggestPayee(tx) {
  let name = (tx.original_name || tx.payee || '').trim();
  if (!name) return '';
  for (const re of PAYEE_LEADING_PREFIXES) name = name.replace(re, '').trim();
  name = name.replace(/\d[\d,]*\.?\d*\s*(JMD|USD|GBP|EUR)?\s*\*?\s*/gi, ' ').trim();
  name = name.replace(/\*\s*(BNS|NCB|JN|RBC|CIBC|JMMB|SCOTIABANK)\s*/gi, ' ').trim();
  for (const re of PAYEE_TRAILING_NOISE) name = name.replace(re, '').trim();
  name = name.replace(/\s{2,}/g, ' ').trim();
  if (!name || name.length < 2) return '';
  return payeeTitleCase(name);
}

// ─── Payee Cleanup UI ─────────────────────────────────────────────────────────

function renderPayeeCleanup(txs) {
  const card      = document.getElementById('payee-cleanup-card');
  const body      = document.getElementById('payee-cleanup-body');
  const countBadge = document.getElementById('payee-cleanup-count');
  const applyBtn  = document.getElementById('payee-apply-btn');
  const selAllBtn = document.getElementById('payee-select-all-btn');

  if (!card || !body) return;

  const candidates = txs
    .filter(needsPayeeCleanup)
    .map(tx => ({ tx, suggested: suggestPayee(tx) }))
    .filter(c => c.suggested); // only show if we have a useful suggestion

  if (!candidates.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  if (countBadge) { countBadge.textContent = `${candidates.length} to review`; countBadge.style.display = ''; }

  // Build table rows — each row has a checkbox, date, original name, and editable suggestion
  body.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead>
          <tr style="color:var(--text-muted);border-bottom:1px solid var(--border);">
            <th style="padding:6px 8px;width:32px;"></th>
            <th style="padding:6px 8px;white-space:nowrap;">Date</th>
            <th style="padding:6px 8px;">Current / Original Name</th>
            <th style="padding:6px 8px;">Suggested Payee</th>
          </tr>
        </thead>
        <tbody>
          ${candidates.map((c, i) => `
            <tr class="payee-cleanup-row" data-idx="${i}" data-txid="${c.tx.id}"
                style="border-bottom:1px solid var(--border);">
              <td style="padding:6px 8px;text-align:center;">
                <input type="checkbox" class="payee-row-cb" data-idx="${i}" checked />
              </td>
              <td style="padding:6px 8px;white-space:nowrap;color:var(--text-muted);">${escHtml(c.tx.date || '')}</td>
              <td style="padding:6px 8px;max-width:280px;">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(c.tx.original_name || c.tx.payee || '')}">
                  ${escHtml(c.tx.payee || c.tx.original_name || '—')}
                </div>
              </td>
              <td style="padding:4px 8px;">
                <input type="text" class="payee-suggestion-input" data-idx="${i}"
                  value="${escHtml(c.suggested)}"
                  style="width:100%;min-width:160px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 6px;color:var(--text);font-size:12px;" />
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Store candidates on the card element for use during apply
  card._candidates = candidates;

  // Update apply button state based on checkbox state
  function updateApplyBtn() {
    const anyChecked = body.querySelectorAll('.payee-row-cb:checked').length > 0;
    if (applyBtn) applyBtn.disabled = !anyChecked;
  }
  body.addEventListener('change', e => { if (e.target.classList.contains('payee-row-cb')) updateApplyBtn(); });
  updateApplyBtn();

  // Select all / deselect all toggle
  if (selAllBtn) {
    selAllBtn._allSelected = true;
    selAllBtn.addEventListener('click', () => {
      selAllBtn._allSelected = !selAllBtn._allSelected;
      body.querySelectorAll('.payee-row-cb').forEach(cb => { cb.checked = selAllBtn._allSelected; });
      selAllBtn.textContent = selAllBtn._allSelected ? 'Deselect All' : 'Select All';
      updateApplyBtn();
    });
    selAllBtn.textContent = 'Deselect All'; // all start checked
    selAllBtn._allSelected = true;
  }

  // Apply button
  if (applyBtn) {
    // Remove old listener by replacing the button node
    const fresh = applyBtn.cloneNode(true);
    applyBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => applyPayeeUpdates(card, body, fresh, countBadge));
  }
}

async function applyPayeeUpdates(card, body, applyBtn, countBadge) {
  if (!state.apiKey) { toast('Not connected to LunchMoney', 'error'); return; }

  const candidates = card._candidates || [];
  const updates = [];

  body.querySelectorAll('.payee-row-cb:checked').forEach(cb => {
    const idx     = parseInt(cb.dataset.idx);
    const input   = body.querySelector(`.payee-suggestion-input[data-idx="${idx}"]`);
    const row     = body.querySelector(`.payee-cleanup-row[data-idx="${idx}"]`);
    const txId    = parseInt(row?.dataset.txid);
    const payee   = input?.value.trim();
    if (txId && payee) updates.push({ id: txId, payee });
  });

  if (!updates.length) { toast('No transactions selected', 'info'); return; }

  applyBtn.disabled = true;
  applyBtn.innerHTML = `<span class="spinner"></span> Updating ${updates.length}…`;

  const res = await window.electronAPI.updatePayeeBatch({ apiKey: state.apiKey, updates });

  applyBtn.disabled = false;
  applyBtn.innerHTML = 'Apply Selected';

  if (!res.success) { toast(`Update failed: ${res.error}`, 'error'); return; }

  const { updated, errors } = res.data;
  if (errors.length) toast(`Updated ${updated}, ${errors.length} error(s)`, 'warn');
  else               toast(`✓ Updated ${updated} payee${updated !== 1 ? 's' : ''} in LunchMoney`, 'success');

  // Reload the account view to reflect the changes
  if (state._accountViewAsset) loadAccountSummary(state._accountViewAsset);
}

/** Wire up the static controls on the account summary view (back btn, year change). */
function setupAccountView() {
  document.getElementById('account-back-btn').addEventListener('click', () => {
    navigateTo('dashboard');
  });
  document.getElementById('account-refresh-btn').addEventListener('click', () => {
    const asset = state._accountViewAsset;
    if (asset) loadAccountSummary(asset);
  });
  document.getElementById('account-year-select').addEventListener('change', () => {
    const asset = state._accountViewAsset;
    if (asset) loadAccountSummary(asset);
  });
}

/** Navigate to the account view for a given LunchMoney asset object. */
function showAccountView(asset) {
  state._accountViewAsset = asset;

  // Populate year selector (current year back to oldest or 5 years)
  const sel = document.getElementById('account-year-select');
  const cur = new Date().getFullYear();
  sel.innerHTML = '';
  for (let y = cur; y >= cur - 6; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === cur) opt.selected = true;
    sel.appendChild(opt);
  }

  // Update header
  document.getElementById('account-view-name').textContent =
    asset.display_name || asset.name || 'Account';
  document.getElementById('account-view-meta').textContent =
    [asset.institution_name, asset.type_name, (asset.currency || '').toUpperCase()]
      .filter(Boolean).join(' · ');

  navigateTo('account');
  loadAccountSummary(asset);
}

/** Fetch transactions for the selected year and render the account summary. */
async function loadAccountSummary(asset) {
  const year    = parseInt(document.getElementById('account-year-select').value);
  const statsEl = document.getElementById('account-summary-stats');
  const monthEl = document.getElementById('account-monthly-wrap');
  const txEl    = document.getElementById('account-tx-list');
  const cntEl   = document.getElementById('account-tx-count');

  statsEl.innerHTML = monthEl.innerHTML = txEl.innerHTML = '';
  monthEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:12px 0;"><span class="spinner"></span> Loading ${year} transactions…</div>`;

  if (!state.apiKey) {
    monthEl.innerHTML = `<div class="empty-state"><p>Connect to LunchMoney in Settings to view account data.</p></div>`;
    return;
  }

  const res = await window.electronAPI.getAccountTransactions({
    apiKey:  state.apiKey,
    assetId: asset.id,
    year,
  });

  if (!res.success) {
    monthEl.innerHTML = `<div style="color:var(--warn);padding:12px 0;">Error: ${escHtml(res.error)}</div>`;
    return;
  }

  const txs = res.data || [];
  renderAccountSummary(asset, year, txs);
}

function renderAccountSummary(asset, year, txs) {
  const fmt     = v => `$${Number(v || 0).toLocaleString('en-JM', { minimumFractionDigits: 2 })}`;
  const cur     = (asset.currency || 'JMD').toUpperCase();
  const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now     = new Date();

  // Build per-month buckets
  const months = Array.from({ length: 12 }, (_, i) => ({
    label: MONTHS[i], idx: i,
    income: 0, expenses: 0, count: 0,
    isFuture: new Date(year, i, 1) > now,
  }));

  txs.forEach(tx => {
    const m = parseInt((tx.date || '').slice(5, 7), 10) - 1;
    if (m < 0 || m > 11) return;
    const amount = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
    months[m].count++;
    if (amount < 0)  months[m].income   += Math.abs(amount);
    else             months[m].expenses += amount;
  });

  // Summary stats
  const totalIncome   = months.reduce((s, m) => s + m.income, 0);
  const totalExpenses = months.reduce((s, m) => s + m.expenses, 0);
  const net           = totalIncome - totalExpenses;
  const statsEl       = document.getElementById('account-summary-stats');
  statsEl.innerHTML   = `
    <div class="stat-card">
      <div class="stat-label">Total Income (${year})</div>
      <div class="stat-value" style="font-size:18px;color:var(--accent2);">${fmt(totalIncome)}</div>
      <div class="stat-sub">${cur}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Expenses (${year})</div>
      <div class="stat-value" style="font-size:18px;color:var(--warn);">${fmt(totalExpenses)}</div>
      <div class="stat-sub">${cur}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net (${year})</div>
      <div class="stat-value" style="font-size:18px;color:${net >= 0 ? 'var(--accent2)' : 'var(--warn)'};">${fmt(net)}</div>
      <div class="stat-sub">${txs.length} transactions</div>
    </div>
  `;

  // Monthly breakdown table
  const maxBar = Math.max(...months.map(m => m.income + m.expenses), 1);
  const monthEl = document.getElementById('account-monthly-wrap');
  if (!txs.length) {
    monthEl.innerHTML = `<div class="empty-state" style="padding:24px 0;"><div class="empty-icon">📭</div><p>No transactions found for ${year}.</p></div>`;
  } else {
    monthEl.innerHTML = `
      <table class="acct-monthly-table">
        <thead>
          <tr>
            <th>Month</th>
            <th class="num">Income</th>
            <th class="num">Expenses</th>
            <th class="num">Net</th>
            <th class="num"># Txns</th>
          </tr>
        </thead>
        <tbody>
          ${months.map(m => {
            if (m.isFuture && m.count === 0) return '';
            const netM = m.income - m.expenses;
            const barW = Math.round(((m.income + m.expenses) / maxBar) * 100);
            return `
              <tr>
                <td>
                  <div>${m.label}</div>
                  <div class="acct-month-bar" style="width:${barW}%;background:${netM >= 0 ? 'var(--accent2)' : 'var(--warn)'};"></div>
                </td>
                <td class="num pos">${m.income  > 0 ? fmt(m.income)  : '—'}</td>
                <td class="num neg">${m.expenses > 0 ? fmt(m.expenses) : '—'}</td>
                <td class="num ${netM >= 0 ? 'pos' : 'neg'}">${m.income > 0 || m.expenses > 0 ? fmt(netM) : '—'}</td>
                <td class="num">${m.count || '—'}</td>
              </tr>`;
          }).join('')}
          <tr class="month-total">
            <td>Total</td>
            <td class="num pos">${fmt(totalIncome)}</td>
            <td class="num neg">${fmt(totalExpenses)}</td>
            <td class="num ${net >= 0 ? 'pos' : 'neg'}">${fmt(net)}</td>
            <td class="num">${txs.length}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  // Transaction list (newest first)
  const cntEl = document.getElementById('account-tx-count');
  const txEl  = document.getElementById('account-tx-list');
  if (cntEl) cntEl.textContent = `${txs.length} transaction${txs.length !== 1 ? 's' : ''}`;

  renderPayeeCleanup(txs);

  if (!txs.length) {
    txEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No transactions for ${year}.</div>`;
    return;
  }

  const sorted = [...txs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  txEl.innerHTML = sorted.map(tx => {
    const amount = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
    const isCredit = amount < 0;
    const dispAmt  = Math.abs(amount);
    return `<div class="acct-tx-row">
      <div class="acct-tx-date">${escHtml(tx.date || '')}</div>
      <div style="flex:1;min-width:0;">
        <div class="acct-tx-payee">${escHtml(tx.payee || tx.original_name || '—')}</div>
        ${tx.category_name ? `<div class="acct-tx-cat">${escHtml(tx.category_name)}</div>` : ''}
      </div>
      <div class="acct-tx-amount ${isCredit ? 'credit' : 'debit'}">
        ${isCredit ? '+' : '−'} ${cur} ${fmtAmount(dispAmt)}
      </div>
    </div>`;
  }).join('');
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

  const tz  = getAppTimezone();
  const res = await window.electronAPI.generateS04A({ currentYear: year, apiKey: state.apiKey || null, timezone: tz === 'system' ? getSystemTimezone() : tz });
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

// ═══════════════════════════════════════════════════════════════════════════════
//  TAJ FIELD MAPPING CARD  +  PDF EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the TAJ S04 field mapping card as a DOM element.
 * Each row maps a TAJ form line number + field label to the computed MiTax value,
 * with a one-click copy button so the user can paste directly into mytaxes.ads.taj.gov.jm.
 */
function buildFieldMappingCard(report) {
  const f     = v => Number(v || 0).toLocaleString('en-JM', { minimumFractionDigits: 2 });
  const fJMD  = v => `$${f(v)} JMD`;

  // TAJ S04 form field definitions  (line, TAJ label, value, css-class)
  const SECTIONS = [
    {
      title: 'Part A — Income from Self-Employment',
      rows: [
        ['A1', 'Business / Professional Income',      fJMD(report.income.businessProfessionalIncome), ''],
        ['A2', 'Foreign-Sourced Income',               fJMD(report.income.foreignSourcedIncome),       ''],
        ['A3', 'Investment Income (Dividends / Interest)', fJMD(report.income.investmentIncome),       ''],
        ['A4', 'Rental Income',                        fJMD(report.income.rentalIncome),               ''],
        ['A5', 'Other Income',                         fJMD(report.income.otherIncome),                ''],
        ['A6', 'TOTAL GROSS INCOME  (A1 + A2 + A3 + A4 + A5)', fJMD(report.income.grossIncome),      'total'],
      ],
    },
    {
      title: 'Part B — Allowable Deductions',
      rows: [
        ['B7', `Allowable Business Expenses  (${report.deductions.methodUsed})`,
               fJMD(report.deductions.allowableBusinessExpenses), ''],
        ['B8', 'STATUTORY INCOME  (A6 − B7)', fJMD(report.statutoryIncome), 'total'],
      ],
    },
    {
      title: 'Part C — Statutory Contributions',
      rows: [
        ['C9',  'NIS Contributions  (3%)',            fJMD(report.contributions.nis),           ''],
        ['C10', 'NHT Contributions  (2%)',            fJMD(report.contributions.nht),           ''],
        ['C11', 'Education Tax  (2.25%)',             fJMD(report.contributions.educationTax),  ''],
        ['C12', 'TOTAL CONTRIBUTIONS  (C9 + C10 + C11)', fJMD(report.contributions.totalContributions), 'total'],
      ],
    },
    {
      title: 'Part D — Chargeable Income & Income Tax',
      rows: [
        ['D13', 'Income Tax Threshold (Personal Allowance)', fJMD(report.personalThresholdApplied), ''],
        ['D14', 'CHARGEABLE INCOME  (B8 − C12 − D13)',       fJMD(report.chargeableIncome),         'total'],
        ['D15', 'Income Tax Payable  (25% / 30%)',            fJMD(report.tax.incomeTax),            ''],
      ],
    },
    {
      title: 'Summary — Total Tax Payable',
      rows: [
        ['E16', 'TOTAL TAX PAYABLE  (C12 + D15)', fJMD(report.totalTaxPayable), 'total'],
        ['E17', 'Net Income After Tax',            fJMD(report.summary.netIncomeAfterTax), 'credit'],
      ],
    },
  ];

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-top:16px;display:none;';  // hidden until toggled

  let sectionsHtml = SECTIONS.map(sec => `
    <div class="field-map-section">
      <div class="field-map-section-title">${escHtml(sec.title)}</div>
      ${sec.rows.map(([line, label, value, cls]) => `
        <div class="field-map-row">
          <span class="field-map-line">${escHtml(line)}</span>
          <span class="field-map-label">${escHtml(label)}</span>
          <span class="field-map-value ${cls}">${escHtml(value)}</span>
          <button class="field-map-copy" data-value="${escAttr(value)}" title="Copy to clipboard">Copy</button>
        </div>
      `).join('')}
    </div>
  `).join('');

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
      <div style="flex:1;">
        <div style="font-size:15px;font-weight:700;">📋 TAJ e-Services Field Guide</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
          Maps each MiTax figure to the exact field on the
          <a href="#" id="taj-link-in-card" style="color:var(--accent);">TAJ e-Services S04 form</a>.
          Click <strong>Copy</strong> to copy a value, then paste directly into mytaxes.ads.taj.gov.jm.
        </div>
      </div>
      <span class="badge" style="background:rgba(88,166,255,0.15);color:var(--accent);font-size:10px;">Tax Year ${report.year}</span>
    </div>
    ${sectionsHtml}
    <div style="margin-top:12px;padding:10px;background:var(--surface2);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.7;">
      ⚠ These figures are MiTax estimates only. Verify with your actual records before submitting to TAJ.
      All amounts are in JMD. Consult a qualified tax practitioner for official advice.
    </div>
  `;

  // Wire copy buttons
  card.querySelectorAll('.field-map-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.value).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
      });
    });
  });

  // Wire TAJ portal link inside the card
  const tajLink = card.querySelector('#taj-link-in-card');
  if (tajLink) {
    tajLink.addEventListener('click', e => {
      e.preventDefault();
      require('electron').shell.openExternal('https://mytaxes.ads.taj.gov.jm/_/');
    });
  }

  return card;
}

// ─── PDF Export ───────────────────────────────────────────────────────────────

async function exportS04PDF(report) {
  const btn = document.getElementById('export-pdf-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Building PDF…'; }

  const profile  = getProfile();
  const html     = buildPrintHTML(report, profile);
  const filename = `S04-${report.year}-${(profile.fullName || 'taxpayer').replace(/\s+/g, '_')}.pdf`;

  const res = await window.electronAPI.exportS04PDF({ htmlContent: html, filename });

  if (btn) { btn.disabled = false; btn.textContent = '📄 Export PDF'; }

  if (!res.success) {
    if (res.error !== 'Cancelled') toast(`PDF export failed: ${res.error}`, 'error');
    return;
  }
  toast(`PDF saved successfully.`, 'success');
}

/**
 * Build a fully self-contained, print-ready HTML document that mirrors the
 * official TAJ S04 form layout.  All CSS is inlined so Chromium's PDF
 * engine renders it correctly with no external dependencies.
 */
function buildPrintHTML(report, profile = {}) {
  const f     = v => Number(v || 0).toLocaleString('en-JM', { minimumFractionDigits: 2 });
  const fJMD  = v => `$${f(v)}`;
  const today = new Date().toLocaleDateString('en-JM', { year: 'numeric', month: 'long', day: 'numeric' });

  const row  = (line, label, value, bold = false, indent = false) => `
    <tr class="${bold ? 'total-row' : ''}">
      <td class="line-col">${line}</td>
      <td class="label-col${indent ? ' indent' : ''}">${label}</td>
      <td class="value-col">${value}</td>
    </tr>`;

  const sectionHeader = title => `
    <tr class="section-header"><td colspan="3">${title}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>S04 Tax Return — ${report.year}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Arial', sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
    background: #fff;
    padding: 28px 36px;
  }

  /* ── Header ─────────────────────────────────── */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 18px; border-bottom: 2.5px solid #1a5276; padding-bottom: 14px; }
  .header-left h1 { font-size: 18pt; font-weight: 900; color: #1a5276; letter-spacing: -0.3px; }
  .header-left h2 { font-size: 10pt; font-weight: 400; color: #555; margin-top: 2px; }
  .header-right { text-align: right; font-size: 9pt; color: #555; line-height: 1.7; }
  .header-right .tax-year { font-size: 14pt; font-weight: 800; color: #1a5276; }
  .estimate-banner {
    background: #fff3cd; border: 1px solid #ffc107; border-radius: 5px;
    padding: 6px 12px; font-size: 9pt; color: #856404;
    margin-bottom: 16px; text-align: center; font-weight: 600;
  }

  /* ── Taxpayer Info Box ───────────────────────── */
  .info-box { border: 1px solid #c8d6e0; border-radius: 5px; padding: 10px 14px; margin-bottom: 18px; background: #f4f8fb; }
  .info-box .info-title { font-size: 8pt; font-weight: 700; color: #1a5276; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 7px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px 16px; }
  .info-field label { display: block; font-size: 7.5pt; color: #888; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2px; }
  .info-field .info-value { font-size: 9.5pt; font-weight: 600; border-bottom: 1px solid #c8d6e0; padding-bottom: 2px; min-height: 16px; }
  .info-field .info-value.blank { color: #aaa; font-style: italic; font-weight: 400; }

  /* ── Main Table ──────────────────────────────── */
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .line-col  { width: 48px; font-size: 8.5pt; font-weight: 700; color: #1a5276; text-align: center; vertical-align: middle; padding: 5px 6px; border: 1px solid #d0dde8; background: #f4f8fb; }
  .label-col { padding: 5px 10px; border: 1px solid #d0dde8; vertical-align: middle; font-size: 9.5pt; }
  .label-col.indent { padding-left: 22px; }
  .value-col { width: 150px; text-align: right; padding: 5px 12px; border: 1px solid #d0dde8; font-family: 'Courier New', monospace; font-size: 9.5pt; vertical-align: middle; }
  .section-header td { background: #1a5276; color: #fff; font-size: 9pt; font-weight: 700; padding: 5px 10px; letter-spacing: 0.03em; border: 1px solid #1a5276; }
  .total-row .label-col { font-weight: 700; background: #eaf1f8; }
  .total-row .value-col { font-weight: 800; background: #eaf1f8; font-size: 10pt; }

  /* ── Summary Box ─────────────────────────────── */
  .summary-box {
    border: 2px solid #1a5276; border-radius: 5px;
    padding: 12px 16px; margin-top: 16px; background: #f4f8fb;
    display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;
  }
  .summary-box .summary-item { text-align: center; }
  .summary-box .summary-label { font-size: 8pt; color: #555; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .summary-box .summary-value { font-size: 13pt; font-weight: 800; margin-top: 2px; }
  .summary-box .summary-value.tax   { color: #c0392b; }
  .summary-box .summary-value.net   { color: #1e8449; }
  .summary-box .summary-value.gross { color: #1a5276; }

  /* ── Contributions grid ──────────────────────── */
  .contributions-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 12px 0; }
  .contrib-card { border: 1px solid #c8d6e0; border-radius: 4px; padding: 8px 10px; text-align: center; background: #f9fcff; }
  .contrib-card .c-label { font-size: 8pt; color: #555; font-weight: 700; text-transform: uppercase; }
  .contrib-card .c-value { font-size: 10pt; font-weight: 800; color: #1a5276; margin-top: 3px; font-family: 'Courier New', monospace; }

  /* ── Notes ───────────────────────────────────── */
  .notes { margin-top: 16px; border-top: 1px solid #c8d6e0; padding-top: 10px; }
  .notes p { font-size: 7.5pt; color: #777; line-height: 1.7; margin-bottom: 2px; }
  .notes p::before { content: '• '; color: #1a5276; }

  /* ── Signature block ─────────────────────────── */
  .sig-block { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
  .sig-field { border-bottom: 1px solid #555; padding-bottom: 3px; min-height: 28px; }
  .sig-label { font-size: 7.5pt; color: #888; margin-top: 4px; text-align: center; }

  /* ── Footer ──────────────────────────────────── */
  .footer { margin-top: 14px; font-size: 7.5pt; color: #aaa; text-align: center; border-top: 1px solid #eee; padding-top: 6px; }

  @media print { body { padding: 16px 24px; } }
</style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>S04 — Self-Employed Income Tax Return</h1>
      <h2>Tax Administration Jamaica (TAJ) &nbsp;·&nbsp; Income Tax Act</h2>
    </div>
    <div class="header-right">
      <div class="tax-year">Tax Year ${report.year}</div>
      <div>Generated: ${today}</div>
      <div style="font-size:8pt;margin-top:4px;">January 1 – December 31, ${report.year}</div>
    </div>
  </div>

  <div class="estimate-banner">
    ⚠ ESTIMATE FOR REFERENCE ONLY — Verify all figures before submitting to TAJ. Not a legal filing document.
  </div>

  <!-- Taxpayer Info -->
  <div class="info-box">
    <div class="info-title">Taxpayer Information</div>
    <div class="info-grid">
      <div class="info-field">
        <label>Full Legal Name</label>
        <div class="info-value ${profile.fullName ? '' : 'blank'}">${profile.fullName || '________________________________'}</div>
      </div>
      <div class="info-field">
        <label>TRN</label>
        <div class="info-value ${profile.trn ? '' : 'blank'}">${profile.trn || '___-___-___'}</div>
      </div>
      <div class="info-field">
        <label>Business / Trading Name</label>
        <div class="info-value ${profile.businessName ? '' : 'blank'}">${profile.businessName || '________________________________'}</div>
      </div>
      <div class="info-field">
        <label>Address</label>
        <div class="info-value ${profile.address ? '' : 'blank'}">${profile.address || '________________________________'}</div>
      </div>
    </div>
  </div>

  <!-- Summary (top level) -->
  <div class="summary-box">
    <div class="summary-item">
      <div class="summary-label">Gross Income</div>
      <div class="summary-value gross">${fJMD(report.income.grossIncome)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Statutory Income</div>
      <div class="summary-value gross">${fJMD(report.statutoryIncome)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Chargeable Income</div>
      <div class="summary-value gross">${fJMD(report.chargeableIncome)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Total Tax Payable</div>
      <div class="summary-value tax">${fJMD(report.totalTaxPayable)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Net After Tax</div>
      <div class="summary-value net">${fJMD(report.summary.netIncomeAfterTax)}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Effective Rate</div>
      <div class="summary-value gross">${report.tax.effectiveRate}</div>
    </div>
  </div>

  <!-- Part A -->
  <table style="margin-top:16px;">
    ${sectionHeader('PART A — INCOME FROM SELF-EMPLOYMENT')}
    ${row('A1', 'Business / Professional Income',                   fJMD(report.income.businessProfessionalIncome))}
    ${row('A2', 'Foreign-Sourced Income',                           fJMD(report.income.foreignSourcedIncome))}
    ${row('A3', 'Investment Income (Dividends, Interest, etc.)',    fJMD(report.income.investmentIncome))}
    ${row('A4', 'Rental Income',                                    fJMD(report.income.rentalIncome))}
    ${row('A5', 'Other Income',                                     fJMD(report.income.otherIncome))}
    ${row('A6', 'TOTAL GROSS INCOME  (A1 + A2 + A3 + A4 + A5)',    fJMD(report.income.grossIncome), true)}
  </table>

  <!-- Part B -->
  <table>
    ${sectionHeader('PART B — ALLOWABLE DEDUCTIONS')}
    ${row('B7', `Allowable Business Expenses  (${report.deductions.methodUsed})`,
          fJMD(report.deductions.allowableBusinessExpenses))}
    ${row('B8', 'STATUTORY INCOME  (A6 − B7)',  fJMD(report.statutoryIncome), true)}
  </table>

  <!-- Part C contributions grid -->
  <div class="contributions-grid">
    <div class="contrib-card">
      <div class="c-label">C9 — NIS (3%)</div>
      <div class="c-value">${fJMD(report.contributions.nis)}</div>
    </div>
    <div class="contrib-card">
      <div class="c-label">C10 — NHT (2%)</div>
      <div class="c-value">${fJMD(report.contributions.nht)}</div>
    </div>
    <div class="contrib-card">
      <div class="c-label">C11 — Education Tax (2.25%)</div>
      <div class="c-value">${fJMD(report.contributions.educationTax)}</div>
    </div>
    <div class="contrib-card" style="background:#eaf1f8;border-color:#1a5276;">
      <div class="c-label" style="color:#1a5276;">C12 — Total Contributions</div>
      <div class="c-value">${fJMD(report.contributions.totalContributions)}</div>
    </div>
  </div>

  <!-- Part D -->
  <table>
    ${sectionHeader('PART D — CHARGEABLE INCOME & INCOME TAX')}
    ${row('D13', 'Less: Income Tax Threshold (Personal Allowance)',  fJMD(report.personalThresholdApplied))}
    ${row('D14', 'CHARGEABLE INCOME  (B8 − C12 − D13)',             fJMD(report.chargeableIncome), true)}
    ${row('D15', 'Income Tax Payable  (25% up to $6M / 30% above)', fJMD(report.tax.incomeTax))}
  </table>

  <!-- Total Tax Payable -->
  <table>
    ${sectionHeader('TOTAL TAX PAYABLE')}
    ${row('E16', 'TOTAL TAX PAYABLE  (C12 + D15)',  fJMD(report.totalTaxPayable), true)}
    ${row('E17', 'Net Income After Tax',             fJMD(report.summary.netIncomeAfterTax), true)}
  </table>

  <!-- Notes -->
  <div class="notes">
    ${report.notes.map(n => `<p>${n}</p>`).join('')}
  </div>

  <!-- Signature block -->
  <div class="sig-block" style="margin-top:24px;">
    <div>
      <div class="sig-field"></div>
      <div class="sig-label">Taxpayer Signature</div>
    </div>
    <div>
      <div class="sig-field"></div>
      <div class="sig-label">Date</div>
    </div>
    <div>
      <div class="sig-field"></div>
      <div class="sig-label">TAJ Reference / Receipt No.</div>
    </div>
  </div>

  <div class="footer">
    Generated by MiTax &nbsp;·&nbsp; ${today} &nbsp;·&nbsp; FOR REFERENCE ONLY — This is not a legal filing document.
    File your official return at mytaxes.ads.taj.gov.jm
  </div>

</body>
</html>`;
}
