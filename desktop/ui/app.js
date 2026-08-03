'use strict';

const $ = (id) => document.getElementById(id);

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatRelativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Trims a full browser user-agent string down to something a person reads at a glance. */
function shortDevice(userAgent) {
  if (!userAgent) return 'Unknown device';
  if (/iPhone/.test(userAgent)) return 'iPhone';
  if (/iPad/.test(userAgent)) return 'iPad';
  if (/Android/.test(userAgent)) return 'Android device';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows PC';
  return userAgent.slice(0, 40);
}

// ---------------------------------------------------------------------------
// Nav — panels load their data the moment they become visible, not before.
// ---------------------------------------------------------------------------

const panelLoaders = {
  accounts: () => loadAccounts(),
  devices: () => loadDevices(),
  library: () => loadLibrary(),
  settings: () => loadSettings(),
};

for (const item of document.querySelectorAll('.nav__item')) {
  item.addEventListener('click', () => {
    for (const el of document.querySelectorAll('.nav__item')) el.classList.remove('is-active');
    for (const el of document.querySelectorAll('.panel')) el.classList.remove('is-active');
    item.classList.add('is-active');
    $(`panel-${item.dataset.panel}`).classList.add('is-active');
    panelLoaders[item.dataset.panel]?.();
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function formatAddress(scheme, host, port) {
  return `${scheme}://${host}:${port}`;
}

function render(status) {
  const running = status.running;

  // Nav rail indicator
  $('navStatus').classList.toggle('is-running', running);
  $('navStatusLabel').textContent = running ? 'Running' : 'Stopped';

  // Status card
  $('statusRow').classList.toggle('is-running', running);
  $('statusLabel').textContent = running
    ? `Running on port ${status.port}`
    : 'Stopped';
  $('toggleBtn').textContent = running ? 'Stop' : 'Start';
  $('toggleBtn').className = `btn ${running ? 'btn--danger' : 'btn--primary'}`;

  $('ffmpegNote').textContent = status.ffmpegReady
    ? ''
    : 'ffmpeg was not found — video thumbnails and HEVC playback for non-Apple devices are disabled.';

  // First-run password banner
  if (status.generatedPassword) {
    $('firstRunCard').hidden = false;
    $('firstRunPassword').textContent = status.generatedPassword;
  }

  // Addresses
  const addrList = $('addrList');
  addrList.textContent = '';
  if (running) {
    const rows = [
      { tag: 'This PC', value: formatAddress('http', 'localhost', status.port) },
      ...status.addresses.map((ip) => ({ tag: 'LAN', value: formatAddress('http', ip, status.port) })),
      { tag: 'Apple', value: formatAddress('http', status.mdnsHost, status.port) },
    ];
    if (status.httpsPort) {
      rows.push({ tag: 'Secure', value: formatAddress('https', status.addresses[0] || status.mdnsHost, status.httpsPort) });
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'addr';
      el.innerHTML = `<span class="addr__tag"></span><span class="addr__value"></span>`;
      el.querySelector('.addr__tag').textContent = row.tag;
      el.querySelector('.addr__value').textContent = row.value;
      addrList.append(el);
    }
  } else {
    const el = document.createElement('p');
    el.className = 'panel__sub';
    el.style.margin = '0';
    el.textContent = 'Start the server to see addresses here.';
    addrList.append(el);
  }

  // QR
  $('qrWrap').hidden = !(running && status.qrDataUrl);
  if (status.qrDataUrl) $('qrImg').src = status.qrDataUrl;

  $('libraryPath').textContent = status.library;
}

async function refresh() {
  const status = await window.lanshare.getStatus();
  render(status);
}

$('toggleBtn').addEventListener('click', async () => {
  $('toggleBtn').disabled = true;
  try {
    const status = $('toggleBtn').textContent === 'Start'
      ? await window.lanshare.startServer()
      : await window.lanshare.stopServer();
    render(status);
  } finally {
    $('toggleBtn').disabled = false;
  }
});

$('openLibraryBtn').addEventListener('click', () => window.lanshare.openLibraryFolder());
$('quitBtn').addEventListener('click', () => window.lanshare.quit());

window.lanshare.onStatusChanged(refresh);
refresh();

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

let editingUsername = null; // null means the form is in "add" mode

function rootsToText(roots) {
  if (!roots || roots.includes('/')) return '';
  return roots.map((r) => r.replace(/^\//, '')).join(', ');
}

function textToRoots(text) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return ['/'];
  return parts.map((p) => (p.startsWith('/') ? p : `/${p}`));
}

async function loadAccounts() {
  const accounts = await window.lanshare.accounts.list();
  const list = $('accountsList');
  list.textContent = '';

  if (!accounts.length) {
    list.innerHTML = '<p class="empty-note">No accounts yet.</p>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'row-list';

  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = `row${account.disabled ? ' is-disabled' : ''}`;

    const rootsLabel = (account.roots || ['/']).includes('/')
      ? 'Full library'
      : `Restricted: ${(account.roots || []).map((r) => r.replace(/^\//, '')).join(', ')}`;

    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <span class="badge badge--${account.role}"></span>
      <div class="row__actions">
        <button class="btn btn--sm" data-action="edit">Edit</button>
        <button class="btn btn--sm btn--danger" data-action="delete">Delete</button>
      </div>`;

    row.querySelector('.row__title').textContent = account.username + (account.disabled ? ' (disabled)' : '');
    row.querySelector('.row__sub').textContent = rootsLabel;
    row.querySelector('.badge').textContent = account.role;

    row.querySelector('[data-action="edit"]').addEventListener('click', () => beginEditAccount(account));
    row.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAccount(account.username));

    wrap.append(row);
  }
  list.append(wrap);
}

function beginEditAccount(account) {
  editingUsername = account.username;
  $('accountFormTitle').textContent = `Edit ${account.username}`;
  $('acctUsername').value = account.username;
  $('acctUsername').disabled = true;
  $('acctPassword').value = '';
  $('acctPassword').placeholder = '';
  $('acctPasswordHint').textContent = 'Leave blank to keep the current password.';
  $('acctRole').value = account.role;
  $('acctRoots').value = rootsToText(account.roots);
  $('acctDisabled').checked = Boolean(account.disabled);
  $('acctSubmitBtn').textContent = 'Save changes';
  $('acctCancelBtn').hidden = false;
  $('acctError').classList.remove('is-shown');
  window.scrollTo?.(0, 0);
}

function resetAccountForm() {
  editingUsername = null;
  $('accountFormTitle').textContent = 'Add an account';
  $('accountForm').reset();
  $('acctUsername').disabled = false;
  $('acctPasswordHint').textContent = 'At least 4 characters.';
  $('acctSubmitBtn').textContent = 'Add account';
  $('acctCancelBtn').hidden = true;
  $('acctError').classList.remove('is-shown');
}

async function deleteAccount(username) {
  if (!confirm(`Delete the account "${username}"? This cannot be undone.`)) return;
  const result = await window.lanshare.accounts.remove(username);
  if (!result.ok) { alert(result.error); return; }
  if (editingUsername === username) resetAccountForm();
  await loadAccounts();
}

$('acctCancelBtn').addEventListener('click', resetAccountForm);

$('accountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('acctError');
  errorEl.classList.remove('is-shown');

  const username = $('acctUsername').value.trim();
  const password = $('acctPassword').value;
  const role = $('acctRole').value;
  const roots = textToRoots($('acctRoots').value);

  let result;
  if (editingUsername) {
    const patch = { role, roots, disabled: $('acctDisabled').checked };
    if (password) patch.password = password;
    result = await window.lanshare.accounts.update(editingUsername, patch);
  } else {
    if (!password) {
      errorEl.textContent = 'Password is required for a new account.';
      errorEl.classList.add('is-shown');
      return;
    }
    result = await window.lanshare.accounts.create({ username, password, role, roots });
  }

  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.classList.add('is-shown');
    return;
  }

  resetAccountForm();
  await loadAccounts();
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

async function loadDevices() {
  const items = await window.lanshare.sessions.list();
  const list = $('devicesList');
  list.textContent = '';

  if (!items.length) {
    list.innerHTML = '<p class="empty-note">No one is signed in right now.</p>';
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'row-list';

  for (const session of items) {
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm btn--danger" data-action="revoke">Sign out</button>
      </div>`;
    row.className = 'row';
    row.querySelector('.row__title').textContent = `${session.username} — ${shortDevice(session.userAgent)}`;
    row.querySelector('.row__sub').textContent =
      `${session.ip || 'unknown IP'} · last seen ${formatRelativeTime(session.lastSeen)}`;
    row.querySelector('[data-action="revoke"]').addEventListener('click', async () => {
      await window.lanshare.sessions.revoke(session.id);
      await loadDevices();
    });
    wrap.append(row);
  }
  list.append(wrap);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function loadLibrary() {
  const stats = await window.lanshare.library.stats();
  $('libStatsPath').textContent = stats.path;

  const cells = [
    ['Library', stats.total],
    ['Thumbnails', stats.cache],
    ['Trash', stats.trash],
  ];
  const grid = $('libStatsGrid');
  grid.textContent = '';
  for (const [label, s] of cells) {
    const el = document.createElement('div');
    el.className = 'stat';
    el.innerHTML = '<div class="stat__value"></div><div class="stat__label"></div>';
    el.querySelector('.stat__value').textContent =
      `${formatBytes(s.bytes)}${s.capped ? '+' : ''}`;
    el.querySelector('.stat__label').textContent =
      `${label} · ${s.files}${s.capped ? '+' : ''} files`;
    grid.append(el);
  }
}

$('clearCacheBtn').addEventListener('click', async () => {
  if (!confirm('Clear the thumbnail cache? It will be rebuilt automatically as you browse.')) return;
  await window.lanshare.library.clearCache();
  await loadLibrary();
});

$('emptyTrashBtn').addEventListener('click', async () => {
  if (!confirm('Permanently delete everything in trash? This cannot be undone.')) return;
  await window.lanshare.library.emptyTrash();
  await loadLibrary();
});

$('browseBtn').addEventListener('click', async () => {
  const picked = await window.lanshare.pickFolder();
  if (!picked) return;
  $('movePathInput').value = picked;
  $('moveBtn').disabled = false;
});

$('moveBtn').addEventListener('click', async () => {
  const newPath = $('movePathInput').value;
  if (!newPath) return;
  const mode = document.querySelector('input[name="moveMode"]:checked').value;
  const errorEl = $('moveError');
  errorEl.classList.remove('is-shown');

  const verb = mode === 'move' ? 'move your files to' : 'start using';
  if (!confirm(`This will briefly stop the server while LANShare ${verb}:\n\n${newPath}\n\nContinue?`)) return;

  $('moveBtn').disabled = true;
  $('moveNote').textContent = 'Working — this can take a while for a large library. Do not close LANShare.';
  try {
    const result = await window.lanshare.library.move(newPath, mode);
    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add('is-shown');
      return;
    }
    $('moveNote').textContent = 'Done. The library is now at the new location.';
    $('movePathInput').value = '';
    await loadLibrary();
  } finally {
    $('moveBtn').disabled = true; // stays disabled until a new folder is picked
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function syncHttpsFieldVisibility() {
  $('setHttpsPortField').style.display = $('setHttpsEnabled').checked ? '' : 'none';
}

async function loadSettings() {
  const settings = await window.lanshare.settings.get();
  $('setPort').value = settings.port;
  $('setHttpsEnabled').checked = Boolean(settings.httpsPort);
  $('setHttpsPort').value = settings.httpsPort || 8443;
  $('setSessionDays').value = settings.sessionDays;
  $('setCloseToTray').checked = settings.closeToTray;
  $('setStartOnLogin').checked = settings.startOnLogin;
  syncHttpsFieldVisibility();

  $('firewallCmd').textContent =
    `New-NetFirewallRule -DisplayName "LANShare" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${settings.port},${settings.httpsPort || 8443}`;
}

$('setHttpsEnabled').addEventListener('change', syncHttpsFieldVisibility);

$('copyFirewallBtn').addEventListener('click', () => {
  window.lanshare.copyToClipboard($('firewallCmd').textContent);
});

$('settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('settingsError');
  errorEl.classList.remove('is-shown');

  const patch = {
    port: Number($('setPort').value),
    httpsPort: $('setHttpsEnabled').checked ? Number($('setHttpsPort').value) : 0,
    sessionDays: Number($('setSessionDays').value),
    closeToTray: $('setCloseToTray').checked,
    startOnLogin: $('setStartOnLogin').checked,
  };

  if (!patch.port || patch.port < 1 || patch.port > 65535) {
    errorEl.textContent = 'Enter a valid port number.';
    errorEl.classList.add('is-shown');
    return;
  }
  if (patch.port === patch.httpsPort) {
    errorEl.textContent = 'The regular and secure ports must be different.';
    errorEl.classList.add('is-shown');
    return;
  }

  await window.lanshare.settings.update(patch);
  await loadSettings();
});
