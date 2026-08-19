'use strict';

const $ = (id) => document.getElementById(id);

/**
 * Never let a failed action look like nothing happened.
 *
 * Most ipcMain.handle() calls in desktop/main.js are wrapped in guarded(),
 * which turns *expected* problems ("that album is not a vault") into a
 * {ok:false, error} the calling screen renders itself. guarded() rethrows
 * anything it does not recognise on purpose, so a genuine bug stays loud
 * rather than being swallowed — but "loud" only worked in the main
 * process's console, which nobody running the packaged app ever sees.
 *
 * The realistic case is Windows-specific and not a bug at all: clearing the
 * thumbnail cache or emptying trash calls fs.rm, which throws EBUSY/EPERM if
 * any file in there is open — a thumbnail being served, an antivirus
 * scanner, an Explorer preview pane. The click handler awaited it with no
 * catch, so the promise rejected, the refresh after it never ran, and the
 * button simply did nothing, twice, with no explanation.
 *
 * A plain alert matches how the rest of this window already talks (it uses
 * confirm() throughout) and costs nothing when everything is working.
 */
window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason;
  const message = err?.message || String(err);
  // Electron prefixes an IPC rejection with the handler's own frames; the
  // last line is the part that actually says what went wrong.
  const clean = message.split('\n').pop().trim();
  alert(`That didn't work.\n\n${clean}`);
  event.preventDefault();
});

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
  vaults: () => loadVaults(),
  library: () => loadLibrary(),
  sync: () => loadSync(),
  rules: () => loadRules(),
  assistant: () => loadAssistant(),
  automation: () => loadAutomation(),
  connections: () => loadConnections(),
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
  if (status.version) $('navVersion').textContent = `v${status.version}`;
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
// Vaults
// ---------------------------------------------------------------------------

let selectedVault = null;

async function loadVaults() {
  const list = await window.lanshare.vaults.list();
  const container = $('vaultsList');
  container.textContent = '';

  if (!list.length) {
    container.innerHTML = '<p class="empty-note">No encrypted albums yet.<br>'
      + 'Create one from the gallery on any device: <strong>New vault</strong>.</p>';
    $('vaultDetail').hidden = true;
    selectedVault = null;
    return;
  }

  // A vault that got locked (or the server restarted) while its detail pane
  // was open must not keep showing the unlocked view.
  if (selectedVault && !list.some((v) => v.path === selectedVault.path)) {
    selectedVault = null;
  }

  const wrap = document.createElement('div');
  wrap.className = 'row-list';

  for (const vault of list) {
    const row = document.createElement('div');
    row.className = `row${selectedVault?.path === vault.path ? ' is-selected' : ''}`;
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <span class="badge"></span>`;
    row.querySelector('.row__title').textContent = vault.name;
    row.querySelector('.row__sub').textContent =
      `${vault.path} · ${vault.keyCount} ${vault.keyCount === 1 ? 'key' : 'keys'}`;

    const badge = row.querySelector('.badge');
    if (vault.type === 'e2e') {
      badge.textContent = 'end-to-end';
      badge.classList.add('badge--e2e');
    } else {
      badge.textContent = vault.unlocked ? 'unlocked' : 'locked';
      badge.classList.add(vault.unlocked ? 'badge--unlocked' : 'badge--locked');
    }

    row.addEventListener('click', () => {
      selectedVault = vault;
      renderVaultDetail();
      loadVaults();
    });
    wrap.append(row);
  }
  container.append(wrap);

  if (selectedVault) {
    // Refresh the selection from the list we just fetched, so lock state in
    // the detail pane matches reality rather than whatever it was on click.
    selectedVault = list.find((v) => v.path === selectedVault.path) || null;
  }
  renderVaultDetail();
}

function renderVaultDetail() {
  const detail = $('vaultDetail');
  if (!selectedVault) { detail.hidden = true; return; }

  detail.hidden = false;
  $('vaultDetailName').textContent = selectedVault.name;
  $('vaultDetailPath').textContent = selectedVault.path;
  $('vaultUnlockError').classList.remove('is-shown');
  $('vaultKeyError').classList.remove('is-shown');

  const open = selectedVault.unlocked;
  $('vaultLockedBox').hidden = open;
  $('vaultUnlockedBox').hidden = !open;

  // Never leave a recovery code on screen across selections.
  $('vaultRecoveryCode').hidden = true;
  $('vaultRecoveryCode').textContent = '';
  $('vaultCopyRecoveryBtn').hidden = true;
  $('vaultRecoveryBtn').hidden = false;

  if (open) loadVaultKeys();
}

async function loadVaultKeys() {
  const result = await window.lanshare.vaults.keys(selectedVault.path);
  const container = $('vaultKeysList');
  container.textContent = '';
  if (!result.ok) return;

  for (const key of result.keys) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm btn--danger" data-action="remove">Remove</button>
      </div>`;
    row.querySelector('.row__title').textContent = key.label || 'Passphrase';
    row.querySelector('.row__sub').textContent = `added ${new Date(key.created).toLocaleDateString()}`;
    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      if (!confirm(`Remove "${key.label}"? Anyone using that passphrase will lose access.`)) return;
      const removed = await window.lanshare.vaults.removeKey(selectedVault.path, key.id);
      if (!removed.ok) { alert(removed.error); return; }
      loadVaultKeys();
      loadVaults();
    });
    container.append(row);
  }
}

$('vaultUnlockBtn').addEventListener('click', async () => {
  const secret = $('vaultSecret').value;
  const errorEl = $('vaultUnlockError');
  errorEl.classList.remove('is-shown');
  if (!secret) return;

  $('vaultUnlockBtn').disabled = true;
  try {
    const useRecovery = $('vaultUseRecovery').checked;
    const result = await window.lanshare.vaults.unlock(
      selectedVault.path,
      useRecovery ? { recoveryCode: secret } : { passphrase: secret },
    );
    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add('is-shown');
      return;
    }
    $('vaultSecret').value = '';
    await loadVaults();
  } finally {
    $('vaultUnlockBtn').disabled = false;
  }
});

$('vaultLockBtn').addEventListener('click', async () => {
  await window.lanshare.vaults.lock(selectedVault.path);
  await loadVaults();
});

$('vaultAddKeyBtn').addEventListener('click', async () => {
  const passphrase = $('vaultNewPassphrase').value;
  const label = $('vaultNewLabel').value.trim() || 'Passphrase';
  const errorEl = $('vaultKeyError');
  errorEl.classList.remove('is-shown');

  const result = await window.lanshare.vaults.addKey(selectedVault.path, passphrase, label);
  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.classList.add('is-shown');
    return;
  }
  $('vaultNewPassphrase').value = '';
  $('vaultNewLabel').value = '';
  loadVaultKeys();
  loadVaults();
});

$('vaultRecoveryBtn').addEventListener('click', async () => {
  if (!confirm(
    'Show the recovery code for this album?\n\n'
    + 'Anyone who has it can open this album forever, and it cannot be revoked '
    + 'without re-encrypting everything in it.',
  )) return;

  const result = await window.lanshare.vaults.recoveryCode(selectedVault.path);
  if (!result.ok) { alert(result.error); return; }

  $('vaultRecoveryCode').textContent = result.code;
  $('vaultRecoveryCode').hidden = false;
  $('vaultCopyRecoveryBtn').hidden = false;
  $('vaultRecoveryBtn').hidden = true;
});

$('vaultCopyRecoveryBtn').addEventListener('click', () => {
  window.lanshare.copyToClipboard($('vaultRecoveryCode').textContent);
  $('vaultCopyRecoveryBtn').textContent = 'Copied';
  setTimeout(() => { $('vaultCopyRecoveryBtn').textContent = 'Copy'; }, 1500);
});

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

async function loadLocations() {
  const list = await window.lanshare.locations.list();
  const container = $('locationsList');
  container.textContent = '';

  if (!list.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">No other drives added yet.</p>';
  } else {
    for (const loc of list) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="row__main">
          <div class="row__title"></div>
          <div class="row__sub"></div>
        </div>
        <span class="badge"></span>
        <div class="row__actions">
          <button class="btn btn--sm btn--danger" data-action="remove">Remove</button>
        </div>`;
      row.querySelector('.row__title').textContent = loc.label;
      row.querySelector('.row__sub').textContent = loc.attached
        ? `${loc.path}${loc.albums.length ? ` · ${loc.albums.length} album${loc.albums.length === 1 ? '' : 's'}` : ''}`
        : `not connected · last seen at ${loc.recordedPath}`;

      const badge = row.querySelector('.badge');
      badge.textContent = loc.attached ? 'connected' : 'offline';
      badge.classList.add(loc.attached ? 'badge--unlocked' : 'badge--locked');

      row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
        const result = await window.lanshare.locations.remove(loc.id);
        if (!result.ok) { alert(result.error); return; }
        loadLocations();
        loadRelocatable();
      });
      container.append(row);
    }
  }

  // Moving an album anywhere requires somewhere connected to move it to.
  const connected = list.filter((l) => l.attached);
  $('relocateBox').hidden = connected.length === 0;
  if (connected.length) loadRelocatable(connected);
}

async function loadRelocatable(connected) {
  const drives = connected || (await window.lanshare.locations.list()).filter((l) => l.attached);
  const albums = await window.lanshare.locations.albums();
  const container = $('albumsList');
  container.textContent = '';

  if (!albums.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">No albums yet.</p>';
    return;
  }

  for (const album of albums) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions"></div>`;
    row.querySelector('.row__title').textContent = album.name;

    const actions = row.querySelector('.row__actions');

    if (album.linked) {
      row.querySelector('.row__sub').textContent = album.reachable
        ? `on ${album.location?.label || 'another drive'}`
        : `on ${album.location?.label || 'another drive'} — not connected`;

      const back = document.createElement('button');
      back.className = 'btn btn--sm';
      back.textContent = 'Bring back';
      // Copying from a drive that is not attached is not possible; saying so
      // beats letting someone click and wait for a failure.
      back.disabled = !album.reachable;
      back.addEventListener('click', () => runRelocation(
        `Bring "${album.name}" back into the library?\n\nIts files will be copied back, which can take a while.`,
        () => window.lanshare.locations.bringHome(album.name),
      ));
      actions.append(back);
    } else {
      row.querySelector('.row__sub').textContent = 'in the library';

      const select = document.createElement('select');
      select.className = 'field__input';
      select.style.cssText = 'width:auto;padding:4px 8px;font-size:.6875rem';
      select.innerHTML = '<option value="">Move to…</option>'
        + drives.map((d) => `<option value="${d.id}"></option>`).join('');
      // Set label text separately rather than interpolating it into markup.
      drives.forEach((d, i) => { select.options[i + 1].textContent = d.label; });

      select.addEventListener('change', () => {
        if (!select.value) return;
        const drive = drives.find((d) => d.id === select.value);
        const chosen = select.value;
        select.value = '';
        runRelocation(
          `Move "${album.name}" to ${drive.label}?\n\nIts files are copied there and verified before anything is removed. `
          + 'The album keeps working exactly as it does now on every device.',
          () => window.lanshare.locations.relocate(album.name, chosen),
        );
      });
      actions.append(select);
    }
    container.append(row);
  }
}

/** Both directions copy an entire album, so both need the same guard rails. */
async function runRelocation(confirmText, action) {
  if (!confirm(confirmText)) return;

  const note = $('relocateNote');
  note.textContent = 'Copying — this can take a while for a large album. Do not close LANShare.';
  // Disabling the whole list is blunt, but a second relocation started while
  // the first is mid-copy would be operating on files that are moving.
  $('albumsList').style.pointerEvents = 'none';
  $('albumsList').style.opacity = '0.5';

  try {
    const result = await action();
    note.textContent = result.ok ? 'Done.' : '';
    if (!result.ok) alert(result.error);
  } catch (err) {
    // An unexpected failure in the main process rejects the invoke rather than
    // returning { ok: false }. Without this the note sits on "Copying…" for
    // the rest of the session and nothing ever says why.
    note.textContent = '';
    alert(`The move did not finish: ${err.message}`);
  } finally {
    $('albumsList').style.pointerEvents = '';
    $('albumsList').style.opacity = '';
    await loadLocations();
    await loadLibrary();
  }
}

$('browseLocationBtn').addEventListener('click', async () => {
  const picked = await window.lanshare.pickFolder();
  if (!picked) return;
  $('newLocationPath').value = picked;
  // Suggest the folder's own name, since that is usually what someone would
  // have typed anyway.
  if (!$('newLocationLabel').value) {
    $('newLocationLabel').value = picked.split(/[\\/]/).filter(Boolean).pop() || '';
  }
  $('addLocationBtn').disabled = false;
});

$('addLocationBtn').addEventListener('click', async () => {
  const errorEl = $('locationError');
  errorEl.classList.remove('is-shown');

  const result = await window.lanshare.locations.add(
    $('newLocationLabel').value.trim(),
    $('newLocationPath').value,
  );
  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.classList.add('is-shown');
    return;
  }
  $('newLocationPath').value = '';
  $('newLocationLabel').value = '';
  $('addLocationBtn').disabled = true;
  await loadLocations();
});

async function loadLibrary() {
  await loadLocations();
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

  // A port change restarts the server; disabling the button for the
  // duration stops a rapid double-submit from mutating settings out from
  // under an in-flight restart.
  $('settingsSubmitBtn').disabled = true;
  try {
    await window.lanshare.settings.update(patch);
    await loadSettings();
  } finally {
    $('settingsSubmitBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Targets currently running, so their rows say so and cannot be started twice. */
const runningSyncIds = new Set();
let previewingSyncId = null;

const POLICY_NOTES = {
  'keep-both': 'Both versions are kept — the one from the drive is saved under a new name '
    + 'that says where it came from. Nothing is ever overwritten.',
  'newest-wins': 'The version edited most recently replaces the other. Quieter, but if the '
    + 'two machines’ clocks disagree it can keep the wrong one.',
  mirror: 'The drive is made to match the library exactly, including removing anything the '
    + 'library does not have. Changes made on the drive never come back.',
  pull: 'Files are copied from the drive into your library and the drive is never written '
    + 'to or deleted from. The right choice for a Google Drive or Dropbox folder you want '
    + 'to collect from rather than manage.',
};

$('syncPolicy').addEventListener('change', () => {
  $('syncPolicyNote').textContent = POLICY_NOTES[$('syncPolicy').value] || '';
});

async function loadSync() {
  $('syncPolicyNote').textContent = POLICY_NOTES[$('syncPolicy').value] || '';

  const [{ targets }, albums, drives] = await Promise.all([
    window.lanshare.sync.list(),
    window.lanshare.sync.albums(),
    window.lanshare.locations.list(),
  ]);

  renderSyncTargets(targets);
  renderSyncSetup(albums, drives);
}

function renderSyncTargets(targets) {
  const container = $('syncList');
  container.textContent = '';

  if (!targets.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">No syncs set up yet.</p>';
    return;
  }

  for (const target of targets) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <span class="badge"></span>
      <div class="row__actions">
        <button class="btn btn--sm" data-action="preview">Preview</button>
        <button class="btn btn--sm btn--danger" data-action="remove">Remove</button>
      </div>`;

    row.querySelector('.row__title').textContent = target.label;
    row.querySelector('.row__sub').textContent = describeSyncTarget(target);

    const badge = row.querySelector('.badge');
    if (runningSyncIds.has(target.id)) {
      badge.textContent = 'running';
      badge.classList.add('badge--unlocked');
    } else if (target.orphaned) {
      badge.textContent = 'drive removed';
      badge.classList.add('badge--locked');
    } else {
      badge.textContent = target.location?.attached ? 'connected' : 'offline';
      badge.classList.add(target.location?.attached ? 'badge--unlocked' : 'badge--locked');
    }

    const previewBtn = row.querySelector('[data-action="preview"]');
    // Comparing needs the drive present. Saying so up front beats a failure
    // after the click.
    previewBtn.disabled = !target.location?.attached || runningSyncIds.has(target.id);
    previewBtn.addEventListener('click', () => showSyncPreview(target));

    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      const ok = confirm(`Stop syncing "${target.label}"?\n\n`
        + 'Nothing already copied is removed — this only stops future syncs.');
      if (!ok) return;
      const result = await window.lanshare.sync.remove(target.id);
      if (!result.ok) { alert(result.error); return; }
      if (previewingSyncId === target.id) hideSyncPreview();
      loadSync();
    });

    container.append(row);
  }
}

function describeSyncTarget(target) {
  if (target.orphaned) return 'The drive this synced to is no longer set up';

  const where = target.location ? target.location.label : 'a drive';
  const what = target.album === '/' ? 'Everything' : target.album;
  const parts = [`${what} → ${where}`];

  if (!target.lastRun) {
    parts.push('never run');
  } else {
    const when = new Date(target.lastRun.at);
    const bits = [];
    if (target.lastRun.copied) bits.push(`${target.lastRun.copied} copied`);
    if (target.lastRun.deleted) bits.push(`${target.lastRun.deleted} removed`);
    if (target.lastRun.conflicts) bits.push(`${target.lastRun.conflicts} conflicts`);
    if (target.lastRun.failed) bits.push(`${target.lastRun.failed} failed`);
    if (target.lastRun.stoppedEarly) bits.push('stopped early');
    parts.push(`last run ${when.toLocaleDateString()} ${when.toLocaleTimeString()}`
      + (bits.length ? ` — ${bits.join(', ')}` : ' — nothing to do'));
  }
  return parts.join(' · ');
}

function renderSyncSetup(albums, drives) {
  const albumSelect = $('syncAlbum');
  albumSelect.textContent = '';
  for (const album of albums) {
    const option = document.createElement('option');
    option.value = album.path;
    option.textContent = album.name;
    albumSelect.append(option);
  }

  const locationSelect = $('syncLocation');
  locationSelect.textContent = '';
  const usable = drives.filter((d) => d.attached);

  if (!usable.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = drives.length
      ? 'No drives connected right now'
      : 'Add a drive on the Library screen first';
    locationSelect.append(option);
    $('addSyncBtn').disabled = true;
    $('syncSetupNote').textContent = drives.length
      ? 'Connect one of your drives to set up a sync to it.'
      : 'Syncs copy to a drive you have registered. Add one under Library → Other drives.';
    return;
  }

  for (const drive of usable) {
    const option = document.createElement('option');
    option.value = drive.id;
    option.textContent = drive.label;
    locationSelect.append(option);
  }
  $('addSyncBtn').disabled = false;
  $('syncSetupNote').textContent = '';
}

$('addSyncBtn').addEventListener('click', async () => {
  const errorEl = $('syncError');
  errorEl.classList.remove('is-shown');

  const result = await window.lanshare.sync.add({
    album: $('syncAlbum').value,
    locationId: $('syncLocation').value,
    policy: $('syncPolicy').value,
    runOnConnect: $('syncOnConnect').checked,
  });

  if (!result.ok) {
    errorEl.textContent = result.error;
    errorEl.classList.add('is-shown');
    return;
  }

  await loadSync();
  // Straight into a preview: the first thing worth knowing about a new sync
  // is what it is about to do, before it does it.
  const { targets } = await window.lanshare.sync.list();
  const created = targets.find((t) => t.id === result.target.id);
  if (created) showSyncPreview(created);
});

async function showSyncPreview(target) {
  previewingSyncId = target.id;
  $('syncPreviewCard').hidden = false;
  $('syncPreviewTitle').textContent = `What "${target.label}" would do`;
  $('syncPreviewGrid').textContent = '';
  $('syncPreviewSkipped').textContent = '';
  $('syncPreviewList').textContent = '';
  $('syncPreviewList').append(noteEl('Working it out…'));
  $('syncConfirmBtn').disabled = true;

  const result = await window.lanshare.sync.preview(target.id);
  if (!result.ok) {
    $('syncPreviewList').textContent = '';
    $('syncPreviewList').append(noteEl(result.error));
    return;
  }

  renderSyncReport(result.report, { preview: true });
  $('syncConfirmBtn').disabled = result.report.planned.total === 0;
  $('syncConfirmBtn').onclick = () => runSyncNow(target);
}

function noteEl(text) {
  const p = document.createElement('p');
  p.className = 'empty-note';
  p.style.padding = '1rem';
  p.textContent = text;
  return p;
}

function renderSyncReport(report, { preview }) {
  const planned = report.planned;
  const cells = [
    ['To the drive', planned.toTarget],
    ['Back to library', planned.toSource],
    ['Removed there', planned.deleteOnTarget],
    ['Removed here', planned.deleteOnSource],
    ['Conflicts', planned.conflicts],
  ];

  const grid = $('syncPreviewGrid');
  grid.textContent = '';
  for (const [label, value] of cells) {
    const cell = document.createElement('div');
    cell.className = 'stat';
    cell.innerHTML = '<div class="stat__value"></div><div class="stat__label"></div>';
    cell.querySelector('.stat__value').textContent = String(value);
    cell.querySelector('.stat__label').textContent = label;
    grid.append(cell);
  }

  const list = $('syncPreviewList');
  list.textContent = '';

  if (report.firstRun && preview) {
    list.append(noteEl('This drive has not been synced before, so nothing will be deleted '
      + 'on this run — the two sides are merged instead.'));
  }

  const actions = report.actions || report.applied || [];
  if (!actions.length && !report.firstRun) {
    list.append(noteEl('Nothing to do — both sides already match.'));
  }

  // Deletions first. They are the only thing here that looks irreversible,
  // and burying them under a hundred copies is how someone approves one blind.
  const ordered = [...actions].sort((a, b) => rankAction(a) - rankAction(b));
  for (const action of ordered.slice(0, 300)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row__main"><div class="row__title"></div>'
      + '<div class="row__sub"></div></div>';
    row.querySelector('.row__title').textContent = action.path;
    row.querySelector('.row__sub').textContent = describeAction(action);
    list.append(row);
  }
  if (ordered.length > 300) list.append(noteEl(`…and ${ordered.length - 300} more.`));

  const skipped = report.skipped || [];
  $('syncPreviewSkipped').textContent = skipped.length
    ? `${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped: ${skipped[0].reason}`
    : '';
}

function rankAction(action) {
  if (action.type === 'delete') return 0;
  if (action.type === 'conflict-keep-both' || action.conflict) return 1;
  return 2;
}

function describeAction(action) {
  if (action.type === 'delete') {
    return action.side === 'target'
      ? 'Removed from the drive (moved to its trash folder)'
      : 'Removed from the library (moved to the trash folder)';
  }
  if (action.type === 'conflict-keep-both') {
    return `Changed in both places — the drive's version is kept as "${action.keepAs}"`;
  }
  return action.direction === 'to-target'
    ? `Copied to the drive — ${action.reason}`
    : `Copied back to the library — ${action.reason}`;
}

async function runSyncNow(target) {
  const ok = confirm(`Run "${target.label}" now?\n\n`
    + 'Anything it removes goes to a trash folder on that side, so it can be recovered.');
  if (!ok) return;

  runningSyncIds.add(target.id);
  $('syncConfirmBtn').disabled = true;
  $('syncNote').textContent = `Syncing "${target.label}"…`;
  renderSyncTargets((await window.lanshare.sync.list()).targets);

  try {
    const result = await window.lanshare.sync.run(target.id);
    if (!result.ok) {
      $('syncNote').textContent = '';
      alert(result.error);
      return;
    }

    const report = result.report;
    $('syncPreviewTitle').textContent = `What "${target.label}" did`;
    renderSyncReport(report, { preview: false });

    $('syncNote').textContent = report.stoppedEarly
      ? 'The drive was disconnected part-way through. Nothing was lost — reconnect it and run again to finish.'
      : report.failed.length
        ? `Finished, but ${report.failed.length} file${report.failed.length === 1 ? '' : 's'} could not be copied.`
        : 'Finished.';
  } catch (err) {
    $('syncNote').textContent = '';
    alert(`The sync did not finish: ${err.message}`);
  } finally {
    runningSyncIds.delete(target.id);
    await loadSync();
  }
}

$('syncCancelBtn').addEventListener('click', hideSyncPreview);

function hideSyncPreview() {
  previewingSyncId = null;
  $('syncPreviewCard').hidden = true;
}

window.lanshare.sync.onProgress(({ id, done, total }) => {
  if (!runningSyncIds.has(id)) return;
  $('syncNote').textContent = `Syncing — ${done} of ${total}…`;
});

// A sync that starts on its own, because its drive was plugged in, has to
// show up here too — otherwise the app looks idle while it copies gigabytes.
// ---------------------------------------------------------------------------
// Machines — other LANShare hosts
// ---------------------------------------------------------------------------

/** The connection whose library is open in the browse card, if any. */
let browsingConnection = null;
let browsingPath = '/';

async function loadConnections() {
  const { connections, discovered, keychain } = await window.lanshare.connections.list();

  renderConnections(connections);
  renderDiscovered(discovered);
  await loadTunnelStatus();

  $('connRemember').disabled = !keychain;
  $('connAddNote').textContent = keychain
    ? ''
    : 'This computer has no keychain available, so the password cannot be saved — '
      + 'you will be asked for it each time you connect.';
}

function renderConnections(list) {
  const container = $('connectionsList');
  container.textContent = '';

  if (!list.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">'
      + 'No other machines connected yet.</p>';
    return;
  }

  for (const connection of list) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm" data-action="browse">Browse</button>
        <button class="btn btn--sm btn--danger" data-action="remove">Remove</button>
      </div>`;

    row.querySelector('.row__title').textContent = connection.label;
    row.querySelector('.row__sub').textContent =
      (connection.via === 'relay'
        ? `over the internet via ${connection.relay?.host} as ${connection.username}`
        : `${connection.base} as ${connection.username}`)
      + (connection.hasSavedPassword ? '' : ' · password not saved');

    row.querySelector('[data-action="browse"]')
      .addEventListener('click', () => browseConnection(connection));

    row.querySelector('[data-action="remove"]').addEventListener('click', async () => {
      const ok = confirm(`Disconnect from "${connection.label}"?\n\n`
        + 'Nothing already copied is removed — this only forgets the connection '
        + 'and its saved password.');
      if (!ok) return;
      const result = await window.lanshare.connections.remove(connection.id);
      if (!result.ok) { alert(result.error); return; }
      if (browsingConnection?.id === connection.id) closeBrowse();
      loadConnections();
    });

    container.append(row);
  }
}

function renderDiscovered(hosts) {
  const card = $('discoveredCard');
  const container = $('discoveredList');
  container.textContent = '';

  card.hidden = !hosts?.length;
  if (!hosts?.length) return;

  for (const host of hosts) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm" data-action="use">Use this</button>
      </div>`;
    row.querySelector('.row__title').textContent = host.name;
    row.querySelector('.row__sub').textContent = `${host.address}:${host.httpsPort}`;

    row.querySelector('[data-action="use"]').addEventListener('click', () => {
      $('connAddress').value = `${host.address}:${host.httpsPort}`;
      $('connUsername').focus();
    });
    container.append(row);
  }
}

// --- being reachable over the internet --------------------------------------

async function loadTunnelStatus() {
  const status = await window.lanshare.tunnel.status();

  $('relayHost').value = status.relayHost || $('relayHost').value;
  $('relayPort').value = status.relayPort || 8460;

  $('enableTunnelBtn').hidden = status.enabled;
  $('disableTunnelBtn').hidden = !status.enabled;
  $('showCodeBtn').hidden = !status.enabled;
  $('relayHost').disabled = status.enabled;
  $('relayPort').disabled = status.enabled;

  // The code is never shown unasked — it is the key to this library, and a
  // screen left open should not be one.
  if (!status.enabled) $('pairingCodeBox').hidden = true;
}

$('enableTunnelBtn').addEventListener('click', async () => {
  const errorEl = $('relayError');
  errorEl.classList.remove('is-shown');

  const button = $('enableTunnelBtn');
  button.disabled = true;
  try {
    const result = await window.lanshare.tunnel.enable(
      $('relayHost').value,
      Number($('relayPort').value) || 8460,
    );
    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add('is-shown');
      return;
    }
    showPairingCode(result.code);
    await loadTunnelStatus();
  } finally {
    button.disabled = false;
  }
});

$('disableTunnelBtn').addEventListener('click', async () => {
  const ok = confirm('Stop being reachable over the internet?\n\n'
    + 'The current pairing code stops working. Machines already paired with it '
    + 'will need a new one.');
  if (!ok) return;
  await window.lanshare.tunnel.disable();
  await loadTunnelStatus();
});

$('showCodeBtn').addEventListener('click', async () => {
  const result = await window.lanshare.tunnel.code();
  if (!result.ok) { alert(result.error); return; }
  showPairingCode(result.code);
});

function showPairingCode(code) {
  $('pairingCode').textContent = code;
  $('pairingCodeBox').hidden = false;
}

$('copyCodeBtn').addEventListener('click', () => {
  window.lanshare.copyToClipboard($('pairingCode').textContent);
  $('copyCodeBtn').textContent = 'Copied';
  setTimeout(() => { $('copyCodeBtn').textContent = 'Copy'; }, 1500);
});

$('connMethod').addEventListener('change', () => {
  const overInternet = $('connMethod').value === 'relay';
  $('connAddressField').hidden = overInternet;
  $('connCodeFields').hidden = !overInternet;
  // A machine reached through a relay is usually reached through *your* relay.
  if (overInternet && !$('connRelayHost').value) {
    $('connRelayHost').value = $('relayHost').value;
    $('connRelayPort').value = $('relayPort').value;
  }
});

$('addConnBtn').addEventListener('click', async () => {
  const errorEl = $('connError');
  errorEl.classList.remove('is-shown');

  const button = $('addConnBtn');
  button.disabled = true;
  button.textContent = 'Connecting…';

  const overInternet = $('connMethod').value === 'relay';

  try {
    const result = await window.lanshare.connections.add(overInternet ? {
      code: $('connCode').value,
      relayHost: $('connRelayHost').value,
      relayPort: Number($('connRelayPort').value) || 8460,
      username: $('connUsername').value,
      password: $('connPassword').value,
      remember: $('connRemember').checked,
    } : {
      address: $('connAddress').value,
      username: $('connUsername').value,
      password: $('connPassword').value,
      remember: $('connRemember').checked,
    });

    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add('is-shown');
      return;
    }

    // Never leave a password — or a pairing code, which is one — sitting in a
    // field once it has been used.
    $('connPassword').value = '';
    $('connAddress').value = '';
    $('connUsername').value = '';
    $('connCode').value = '';
    await loadConnections();
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
  }
});

async function browseConnection(connection, remotePath = '/') {
  browsingConnection = connection;
  browsingPath = remotePath;

  $('browseCard').hidden = false;
  $('browseTitle').textContent = `Browsing ${connection.label}`;
  $('browsePath').textContent = remotePath;
  $('browseList').textContent = '';
  $('browseList').append(noteEl('Loading…'));
  $('transferNote').textContent = '';

  let password = null;
  const result = await window.lanshare.connections.browse(connection.id, remotePath);

  if (!result.ok && /password/i.test(result.error || '')) {
    // No saved password on this machine — ask, and keep it only for this call.
    password = prompt(`Password for ${connection.username} on ${connection.label}:`);
    if (!password) { closeBrowse(); return; }
    const retry = await window.lanshare.connections.browse(connection.id, remotePath, password);
    if (!retry.ok) { showBrowseError(retry.error); return; }
    renderBrowse(retry.listing);
    return;
  }

  if (!result.ok) { showBrowseError(result.error); return; }
  renderBrowse(result.listing);
}

function showBrowseError(message) {
  $('browseList').textContent = '';
  $('browseList').append(noteEl(message));
  $('downloadSelectedBtn').disabled = true;
}

function renderBrowse(listing) {
  const container = $('browseList');
  container.textContent = '';
  $('browsePath').textContent = listing.path || '/';
  browsingPath = listing.path || '/';

  if (browsingPath !== '/') {
    const up = document.createElement('div');
    up.className = 'row';
    up.innerHTML = '<div class="row__main"><div class="row__title">← Back</div></div>';
    up.style.cursor = 'pointer';
    up.addEventListener('click', () => {
      const parent = browsingPath.replace(/\/[^/]+$/, '') || '/';
      browseConnection(browsingConnection, parent);
    });
    container.append(up);
  }

  for (const folder of listing.folders || []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cursor = 'pointer';
    row.innerHTML = '<div class="row__main"><div class="row__title"></div>'
      + '<div class="row__sub">Album</div></div>';
    row.querySelector('.row__title').textContent = folder.name;
    row.addEventListener('click', () => browseConnection(browsingConnection, folder.path));
    container.append(row);
  }

  for (const file of listing.files || []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <label class="check-row" style="margin:0;flex:1">
        <input type="checkbox" data-name="">
        <span class="row__title"></span>
      </label>
      <div class="row__sub"></div>`;
    row.querySelector('input').dataset.name = file.name;
    row.querySelector('.row__title').textContent = file.name;
    row.querySelector('.row__sub').textContent = formatBytes(file.size || 0);
    row.querySelector('input').addEventListener('change', updateDownloadButton);
    container.append(row);
  }

  if (!(listing.folders || []).length && !(listing.files || []).length) {
    container.append(noteEl('This album is empty.'));
  }
  updateDownloadButton();
}

function selectedRemoteFiles() {
  return [...$('browseList').querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.dataset.name);
}

function updateDownloadButton() {
  $('downloadSelectedBtn').disabled = selectedRemoteFiles().length === 0;
}

$('downloadSelectedBtn').addEventListener('click', async () => {
  const files = selectedRemoteFiles();
  if (!files.length || !browsingConnection) return;

  await runTransfer('download', {
    id: browsingConnection.id,
    direction: 'download',
    remoteDir: browsingPath,
    localPath: $('browseLocalDir').value || '/',
    files,
  });
});

$('uploadHereBtn').addEventListener('click', async () => {
  if (!browsingConnection) return;
  const picked = await window.lanshare.pickLibraryFiles();
  if (!picked) return;
  if (picked.error) { alert(picked.error); return; }

  await runTransfer('upload', {
    id: browsingConnection.id,
    direction: 'upload',
    remoteDir: browsingPath,
    localPath: picked.dir,
    files: picked.names,
  });
});

async function runTransfer(kind, input) {
  const note = $('transferNote');
  note.textContent = kind === 'download' ? 'Copying here…' : 'Sending…';
  $('downloadSelectedBtn').disabled = true;

  try {
    const result = await window.lanshare.connections.copy(input);
    if (!result.ok) { note.textContent = ''; alert(result.error); return; }

    const { copied, failed, bytes } = result.result;
    note.textContent = failed.length
      ? `${copied.length} copied, ${failed.length} failed — ${failed[0].error}`
      : `${copied.length} file${copied.length === 1 ? '' : 's'} copied (${formatBytes(bytes)}).`;
  } catch (err) {
    note.textContent = '';
    alert(`The transfer did not finish: ${err.message}`);
  } finally {
    updateDownloadButton();
  }
}

$('browseCloseBtn').addEventListener('click', closeBrowse);

function closeBrowse() {
  browsingConnection = null;
  $('browseCard').hidden = true;
}

window.lanshare.connections.onProgress(({ done, total, name }) => {
  if (!browsingConnection) return;
  $('transferNote').textContent = `${done} of ${total} — ${name}`;
});

window.lanshare.sync.onChanged(({ running }) => {
  runningSyncIds.clear();
  for (const id of running || []) runningSyncIds.add(id);

  if (!$('panel-sync').classList.contains('is-active')) return;
  $('syncNote').textContent = running?.length
    ? 'A drive was connected — syncing automatically…'
    : '';
  loadSync();
});

// ---------------------------------------------------------------------------
// Importing from a camera, drone or card (Phase K)
// ---------------------------------------------------------------------------

const CAPTURE_COUNTDOWN_SECONDS = 30;
let captureCountdownTimer = null;
let captureCountdownDeadline = 0;

function stopCaptureCountdown() {
  if (captureCountdownTimer) clearInterval(captureCountdownTimer);
  captureCountdownTimer = null;
}

function showCaptureState(which) {
  $('capturePrompt').hidden = which !== 'prompt';
  $('captureProgress').hidden = which !== 'progress';
  $('captureFailed').hidden = which !== 'failed';
  $('captureDone').hidden = which !== 'done';
}

/**
 * A failed import is a state with a way out, not an error message left on
 * the progress screen. Progress has no buttons on purpose — there is
 * nothing to decide while files are copying — so reusing it for a failure
 * stranded people on a full-screen overlay with nothing to click at all.
 */
function showCaptureFailure(message) {
  showCaptureState('failed');
  $('captureFailedNote').textContent = message || 'The import did not finish.';
}

function renderCapturePrompt(detected) {
  stopCaptureCountdown();
  $('captureOverlay').hidden = false;
  showCaptureState('prompt');

  const already = detected.alreadyImported
    ? ` (${detected.alreadyImported} already imported, skipped)`
    : '';
  $('captureSummary').textContent = `"${detected.label}" — ${detected.fileCount} new `
    + `file${detected.fileCount === 1 ? '' : 's'}, ${formatBytes(detected.totalBytes)}${already}`;

  captureCountdownDeadline = Date.now() + CAPTURE_COUNTDOWN_SECONDS * 1000;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((captureCountdownDeadline - Date.now()) / 1000));
    $('captureCountdown').textContent = remaining > 0
      ? `Starting automatically in ${remaining}s…`
      : 'Starting…';
    if (remaining <= 0) { stopCaptureCountdown(); runCaptureImport(); }
  };
  tick();
  captureCountdownTimer = setInterval(tick, 250);
}

async function runCaptureImport() {
  stopCaptureCountdown();
  showCaptureState('progress');
  $('captureProgressNote').textContent = 'Copying…';
  try {
    const result = await window.lanshare.capture.importNow();
    if (!result.ok) {
      showCaptureFailure(result.error);
      return;
    }
    showCaptureState('done');
    const failedNote = result.failed?.length ? ` (${result.failed.length} could not be copied)` : '';
    const sortedNote = result.sorted
      ? ` ${result.sorted} of them already moved on to where your sorting rules put them.`
      : '';
    $('captureDoneNote').textContent = `Imported ${result.copied} `
      + `file${result.copied === 1 ? '' : 's'} into "${result.destDir}"${failedNote}.${sortedNote}`;
  } catch (err) {
    showCaptureFailure(err.message);
  }
}

$('captureImportBtn').addEventListener('click', () => runCaptureImport());
$('captureRetryBtn').addEventListener('click', () => runCaptureImport());

// Closing after a failure leaves the card pending rather than dismissing it:
// the import did not happen, so the next check should still offer it.
$('captureFailedCloseBtn').addEventListener('click', () => { $('captureOverlay').hidden = true; });

$('captureCancelBtn').addEventListener('click', async () => {
  stopCaptureCountdown();
  await window.lanshare.capture.dismiss();
  $('captureOverlay').hidden = true;
});

$('captureNeverBtn').addEventListener('click', async () => {
  stopCaptureCountdown();
  await window.lanshare.capture.never();
  $('captureOverlay').hidden = true;
});

$('captureCloseBtn').addEventListener('click', () => { $('captureOverlay').hidden = true; });

window.lanshare.capture.onDetected((detected) => renderCapturePrompt(detected));

window.lanshare.capture.onProgress(({ done, total }) => {
  if (!$('captureProgress').hidden) $('captureProgressNote').textContent = `Copying ${done} of ${total}…`;
});

// A detection whose push event fired into a window that did not exist yet
// (showWindow() creates one, but loading it is not instant) would otherwise
// never be shown. Checking once here, after this script has actually
// loaded, is the fallback — main.js keeps the pending detection in memory
// until it is acted on, so nothing is lost, only possibly shown a moment
// later than the push event would have.
window.lanshare.capture.pending().then((detected) => {
  if (detected) renderCapturePrompt(detected);
});

// ---------------------------------------------------------------------------
// Sorting rules (Phase L)
// ---------------------------------------------------------------------------

let lastRulesPlan = null;
/** What the rules said when this editor last loaded them — see the save handler. */
let loadedRulesVersion = null;

async function loadRules() {
  const state = await window.lanshare.rules.get();
  loadedRulesVersion = state.version;
  // Never stomp on text someone is mid-edit of.
  if (document.activeElement !== $('rulesText')) $('rulesText').value = state.text;
  $('rulesError').textContent = state.error || '';
  $('rulesError').classList.toggle('is-shown', Boolean(state.error));

  renderRulesHistory(state.history, state.gitAvailable);
  await loadRulesBatches();
  // Independent of the rules themselves, and a failure here (Ollama not
  // installed at all, say) must not stop the rest of the screen rendering.
  await loadRulesModels().catch(() => {});
}

function renderRulesHistory(history, gitAvailable) {
  $('rulesHistoryCard').hidden = !gitAvailable || !history?.length;
  const container = $('rulesHistoryList');
  container.textContent = '';
  for (const entry of history || []) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row__main"><div class="row__title"></div><div class="row__sub"></div></div>';
    row.querySelector('.row__title').textContent = entry.subject;
    row.querySelector('.row__sub').textContent = `${new Date(entry.date).toLocaleString()} — ${entry.hash.slice(0, 8)}`;
    container.append(row);
  }
}

async function loadRulesBatches() {
  const { batches } = await window.lanshare.rules.batches();
  const container = $('rulesBatchList');
  container.textContent = '';

  if (!batches?.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">Nothing has been sorted yet.</p>';
    $('rulesBatchNote').textContent = '';
    return;
  }

  const latest = batches[0];
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div class="row__main">
      <div class="row__title"></div>
      <div class="row__sub"></div>
    </div>
    <div class="row__actions">
      <button class="btn btn--sm btn--danger" id="rulesUndoBtn">Undo</button>
    </div>`;
  row.querySelector('.row__title').textContent = `${latest.moved.length} file${latest.moved.length === 1 ? '' : 's'} sorted`;
  row.querySelector('.row__sub').textContent = new Date(latest.at).toLocaleString()
    + (latest.failed.length ? ` — ${latest.failed.length} could not be moved` : '');
  container.append(row);

  $('rulesBatchNote').textContent = batches.length > 1 ? `${batches.length - 1} earlier batch(es) also on record.` : '';

  $('rulesUndoBtn').addEventListener('click', async () => {
    $('rulesUndoBtn').disabled = true;
    try {
      const result = await window.lanshare.rules.undo();
      if (!result.ok) { $('rulesBatchNote').textContent = result.error; return; }
      await loadRulesBatches();
    } finally {
      $('rulesUndoBtn').disabled = false;
    }
  });
}

$('rulesSaveBtn').addEventListener('click', async () => {
  $('rulesError').classList.remove('is-shown');
  $('rulesSaveBtn').disabled = true;
  try {
    const result = await window.lanshare.rules.save($('rulesText').value, loadedRulesVersion);

    // Someone (or, later, the assistant) changed the rules while this editor
    // had them open. Nothing was overwritten. Offering the choice beats
    // either silently clobbering their change or silently discarding yours.
    if (result.conflict) {
      const keepMine = confirm(`${result.error}\n\n`
        + 'OK — overwrite with what you have here.\n'
        + 'Cancel — discard your edit and load the current rules.');
      if (keepMine) {
        loadedRulesVersion = result.currentVersion;
        $('rulesSaveBtn').disabled = false;
        $('rulesSaveBtn').click();
        return;
      }
      $('rulesText').value = result.currentText;
      loadedRulesVersion = result.currentVersion;
      $('rulesSaveNote').textContent = 'Loaded the current rules — your edit was not saved.';
      return;
    }

    if (!result.ok) {
      $('rulesError').textContent = result.error;
      $('rulesError').classList.add('is-shown');
      return;
    }
    $('rulesSaveNote').textContent = `Saved — ${result.ruleCount} rule${result.ruleCount === 1 ? '' : 's'} active.`;
    await loadRules();
  } finally {
    $('rulesSaveBtn').disabled = false;
  }
});

$('rulesPreviewBtn').addEventListener('click', async () => {
  $('rulesPreviewBtn').disabled = true;
  $('rulesPreviewBtn').textContent = 'Checking…';
  try {
    const result = await window.lanshare.rules.plan();
    if (!result.ok) {
      $('rulesError').textContent = result.error;
      $('rulesError').classList.add('is-shown');
      return;
    }
    lastRulesPlan = result.result;
    renderRulesPreview(lastRulesPlan);
  } finally {
    $('rulesPreviewBtn').disabled = false;
    $('rulesPreviewBtn').textContent = 'Preview what would move';
  }
});

/** Shared by the main preview list and the natural-language draft's own preview. */
function renderMoveRows(container, moves, limit = 200) {
  container.textContent = '';
  if (!moves.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">Nothing would move — every file is '
      + 'already where its rules put it.</p>';
    return;
  }
  for (const move of moves.slice(0, limit)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row__main"><div class="row__title"></div><div class="row__sub"></div></div>';
    row.querySelector('.row__title').textContent = move.name;
    row.querySelector('.row__sub').textContent = `${move.path}  →  ${move.destinationAlbum}`;
    container.append(row);
  }
}

function renderRulesPreview(planResult) {
  $('rulesPreviewCard').hidden = false;
  renderMoveRows($('rulesPreviewList'), planResult.moves);
  $('rulesPreviewSub').textContent = `${planResult.moves.length} file${planResult.moves.length === 1 ? '' : 's'} `
    + `would move, ${planResult.unmatched.length} match no rule and would stay put.`
    + (planResult.moves.length > 200 ? ' Showing the first 200.' : '');
  $('rulesApplyBtn').disabled = !planResult.moves.length;
}

$('rulesApplyBtn').addEventListener('click', async () => {
  if (!lastRulesPlan?.moves.length) return;
  if (!confirm(`Move ${lastRulesPlan.moves.length} file(s) now? This can be undone as one action afterwards.`)) return;

  $('rulesApplyBtn').disabled = true;
  $('rulesApplyBtn').textContent = 'Applying…';
  try {
    const result = await window.lanshare.rules.apply();
    if (!result.ok) {
      $('rulesPreviewSub').textContent = result.error;
      return;
    }
    $('rulesPreviewCard').hidden = true;
    lastRulesPlan = null;
    await loadRulesBatches();
  } finally {
    $('rulesApplyBtn').disabled = false;
    $('rulesApplyBtn').textContent = 'Apply now';
  }
});

$('rulesPreviewCloseBtn').addEventListener('click', () => { $('rulesPreviewCard').hidden = true; });

// Natural-language drafting (Phase M) — a local model turns a typed sentence
// into one rule line, shown here editable, never saved or run without an
// explicit click. "Run once" and "Add to my rules" both re-validate on the
// main process side regardless of what draftRule originally reported, so
// hand-editing the drafted line before either action is always safe.

/**
 * Show which local models are actually installed, and let one be chosen.
 *
 * Ollama answers a request for a model it does not have with 404, which
 * looks exactly like "the server is not running" while meaning the
 * opposite. With the model previously hardcoded and invisible, that made
 * the whole feature look broken with nothing to act on — so the state of
 * the world is spelled out here rather than left to be deduced from an
 * error code.
 */
async function loadRulesModels() {
  const select = $('rulesModelSelect');
  const note = $('rulesModelNote');
  const result = await window.lanshare.rules.models();
  if (!result.ok) { note.textContent = result.error; return; }

  select.textContent = '';
  for (const name of result.installed) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }

  if (!result.reachable) {
    // No models listed at all means the request for the list failed, which
    // (unlike a missing model) really does mean nothing is answering.
    const opt = document.createElement('option');
    opt.value = result.selected;
    opt.textContent = `${result.selected} (Ollama not reachable)`;
    select.append(opt);
    note.textContent = `Nothing is answering at ${result.host}. Start Ollama, then press Refresh.`;
  } else if (!result.selectedInstalled) {
    note.textContent = `"${result.selected}" is not installed — pick one of the ${result.installed.length} above, `
      + `or run "ollama pull ${result.selected}" to download it.`;
  } else {
    note.textContent = `Drafting with ${result.selected}.`;
  }
  select.value = result.selectedInstalled ? result.selected : (result.installed[0] || result.selected);
}

$('rulesModelSelect').addEventListener('change', async () => {
  const result = await window.lanshare.rules.setModel($('rulesModelSelect').value);
  $('rulesModelNote').textContent = result.ok
    ? `Drafting with ${result.selected}.`
    : result.error;
});

$('rulesModelRefreshBtn').addEventListener('click', () => loadRulesModels());

$('rulesDraftBtn').addEventListener('click', async () => {
  const instruction = $('rulesInstructionInput').value.trim();
  $('rulesDraftError').classList.remove('is-shown');
  if (!instruction) {
    $('rulesDraftError').textContent = 'Type an instruction first';
    $('rulesDraftError').classList.add('is-shown');
    return;
  }

  $('rulesDraftBtn').disabled = true;
  $('rulesDraftBtn').textContent = 'Drafting…';
  try {
    const result = await window.lanshare.rules.draft(instruction);
    if (!result.ok) {
      $('rulesDraftResult').hidden = true;
      $('rulesDraftError').textContent = result.error;
      $('rulesDraftError').classList.add('is-shown');
      return;
    }
    renderRulesDraft(result);
  } finally {
    $('rulesDraftBtn').disabled = false;
    $('rulesDraftBtn').textContent = 'Draft';
  }
});

function renderRulesDraft(result) {
  $('rulesDraftResult').hidden = false;
  $('rulesDraftText').value = result.text;
  $('rulesDraftParseError').textContent = result.error || '';
  $('rulesDraftParseError').classList.toggle('is-shown', Boolean(result.error));
  $('rulesDraftNote').textContent = result.note || '';

  if (result.preview) {
    renderMoveRows($('rulesDraftPreviewList'), result.preview.moves);
    $('rulesDraftPreviewSub').textContent = `${result.preview.moves.length} file${result.preview.moves.length === 1 ? '' : 's'} `
      + `would move, ${result.preview.unmatched.length} match no rule and would stay put.`;
  } else {
    $('rulesDraftPreviewList').textContent = '';
    $('rulesDraftPreviewSub').textContent = '';
  }
}

$('rulesDraftAddBtn').addEventListener('click', () => {
  const text = $('rulesDraftText').value.trim();
  if (!text) return;
  const current = $('rulesText').value;
  $('rulesText').value = current && !current.endsWith('\n') ? `${current}\n${text}` : `${current}${text}`;
  $('rulesDraftResult').hidden = true;
  $('rulesInstructionInput').value = '';
  $('rulesSaveNote').textContent = 'Added below — click "Save rules" to make it active.';
});

$('rulesDraftRunOnceBtn').addEventListener('click', async () => {
  const text = $('rulesDraftText').value.trim();
  if (!text) return;
  if (!confirm('Run this rule once against your library right now? It will not be saved, and '
    + 'can be undone as one action afterwards.')) return;

  $('rulesDraftRunOnceBtn').disabled = true;
  $('rulesDraftRunOnceBtn').textContent = 'Running…';
  try {
    const result = await window.lanshare.rules.runOnce(text);
    if (!result.ok) {
      $('rulesDraftParseError').textContent = result.error;
      $('rulesDraftParseError').classList.add('is-shown');
      return;
    }
    $('rulesDraftResult').hidden = true;
    $('rulesInstructionInput').value = '';
    await loadRulesBatches();
  } finally {
    $('rulesDraftRunOnceBtn').disabled = false;
    $('rulesDraftRunOnceBtn').textContent = 'Run once';
  }
});

$('rulesDraftDiscardBtn').addEventListener('click', () => { $('rulesDraftResult').hidden = true; });

// ---------------------------------------------------------------------------
// Assistant (Phase O3/O4)
// ---------------------------------------------------------------------------
// `assistantConversation` is what converse() returned as `messages` last
// turn — held here, not reloaded from anywhere, since the server is
// deliberately stateless about chat history (see plan.md). Switching to
// another panel and back keeps talking to the same conversation; only
// "New conversation" resets it.

let assistantConversation = [];
let assistantBusy = false;

async function loadAssistant() {
  await loadAssistantModels().catch(() => {});
}

async function loadAssistantModels() {
  const select = $('assistantModelSelect');
  const note = $('assistantModelNote');
  const result = await window.lanshare.assistant.models();
  if (!result.ok) { note.textContent = result.error; return; }

  select.textContent = '';
  for (const name of result.installed) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.append(opt);
  }

  if (!result.reachable) {
    const opt = document.createElement('option');
    opt.value = result.selected;
    opt.textContent = `${result.selected} (Ollama not reachable)`;
    select.append(opt);
    note.textContent = `Nothing is answering at ${result.host}. Start Ollama, then press Refresh.`;
  } else if (!result.selectedInstalled) {
    note.textContent = `"${result.selected}" is not installed — pick one of the ${result.installed.length} above, `
      + `or run "ollama pull ${result.selected}" to download it.`;
  } else {
    note.textContent = `Talking to ${result.selected}.`;
  }
  select.value = result.selectedInstalled ? result.selected : (result.installed[0] || result.selected);
}

$('assistantModelSelect').addEventListener('change', async () => {
  const result = await window.lanshare.assistant.setModel($('assistantModelSelect').value);
  $('assistantModelNote').textContent = result.ok ? `Talking to ${result.selected}.` : result.error;
});
$('assistantModelRefreshBtn').addEventListener('click', () => loadAssistantModels());

function appendChatBubble(role, text) {
  const log = $('assistantLog');
  const el = document.createElement('div');
  el.className = `chat-msg chat-msg--${role}`;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}

/** A tool call, shown as a quiet log line — not a speech bubble — so "what exactly did it do" stays visible without reading like the assistant said it out loud. */
function appendToolLogLine(entry) {
  const log = $('assistantLog');
  const el = document.createElement('div');
  el.className = 'chat-msg chat-msg--tool';
  let label;
  if (entry.error) label = `${entry.name}: ${entry.error}`;
  else if (entry.ranFor === 'preview') label = `${entry.name} — previewed only (trust: ${entry.trustLevel})`;
  else label = `${entry.name} — ran`;
  el.textContent = `\u{1F527} ${label}`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}

async function sendAssistantMessage(text) {
  if (!text.trim() || assistantBusy) return;
  $('assistantError').textContent = '';
  $('assistantError').classList.remove('is-shown');
  $('assistantQuestionBox').hidden = true;
  appendChatBubble('user', text);
  $('assistantInput').value = '';

  assistantBusy = true;
  $('assistantSendBtn').disabled = true;
  $('assistantSendBtn').textContent = 'Thinking…';
  try {
    const result = await window.lanshare.assistant.message(text, assistantConversation);
    if (!result.ok) {
      $('assistantError').textContent = result.error;
      $('assistantError').classList.add('is-shown');
      return;
    }
    assistantConversation = result.messages;
    for (const entry of result.toolLog) appendToolLogLine(entry);

    if (result.question) {
      $('assistantQuestionText').textContent = result.question.question;
      const optionsBox = $('assistantQuestionOptions');
      optionsBox.textContent = '';
      for (const option of result.question.options) {
        const btn = document.createElement('button');
        btn.className = 'btn btn--sm';
        btn.textContent = option;
        btn.addEventListener('click', () => sendAssistantMessage(option));
        optionsBox.append(btn);
      }
      $('assistantQuestionBox').hidden = false;
    } else if (result.reply) {
      appendChatBubble('assistant', result.reply);
    }
  } finally {
    assistantBusy = false;
    $('assistantSendBtn').disabled = false;
    $('assistantSendBtn').textContent = 'Send';
  }
}

$('assistantSendBtn').addEventListener('click', () => sendAssistantMessage($('assistantInput').value));
$('assistantInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAssistantMessage($('assistantInput').value);
  }
});
$('assistantNewConversationBtn').addEventListener('click', () => {
  assistantConversation = [];
  $('assistantLog').textContent = '';
  $('assistantQuestionBox').hidden = true;
  $('assistantError').textContent = '';
  $('assistantError').classList.remove('is-shown');
});

// ---------------------------------------------------------------------------
// Automation: trust levels and the Ghost Mode review queue (Phase O2/O4)
// ---------------------------------------------------------------------------

const TRUST_LABELS = { ask: 'Ask', ghost: 'Ghost', auto: 'Auto' };
const ACTION_TYPE_LABELS = { trip_cluster: 'Trip clustering', camera_correction: 'Camera clock correction' };

async function loadAutomation() {
  await loadTrustList();
  await loadGhostQueue();
  await loadGhostApproved();
  await loadAuditLog();
}

async function loadTrustList() {
  const result = await window.lanshare.trust.list();
  const container = $('trustList');
  container.textContent = '';
  if (!result.ok) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem"></p>';
    container.querySelector('.empty-note').textContent = result.error;
    return;
  }

  for (const entry of result.actionTypes) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <select class="select trust-select"></select>
      </div>`;
    row.querySelector('.row__title').textContent = ACTION_TYPE_LABELS[entry.actionType] || entry.actionType;

    let sub = '';
    if (entry.eligibleFor === 'ghost') sub = `Eligible for Ghost — ${entry.evidence.consecutiveApprovals} approvals in a row.`;
    else if (entry.eligibleFor === 'auto') sub = `Eligible for Auto — ${entry.evidence.ghostLogs} ghost-logged decisions.`;
    row.querySelector('.row__sub').textContent = sub;

    const select = row.querySelector('.trust-select');
    for (const level of ['ask', 'ghost', 'auto']) {
      const opt = document.createElement('option');
      opt.value = level;
      opt.textContent = TRUST_LABELS[level];
      select.append(opt);
    }
    select.value = entry.level;
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        const setResult = await window.lanshare.trust.set(entry.actionType, select.value);
        if (!setResult.ok) { alert(setResult.error); select.value = entry.level; return; }
        await loadTrustList();
      } finally {
        select.disabled = false;
      }
    });
    container.append(row);
  }
}

async function loadGhostQueue() {
  const result = await window.lanshare.patternEngine.proposals('pending');
  const container = $('ghostQueueList');
  container.textContent = '';
  if (!result.ok || !result.proposals?.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">Nothing waiting for review.</p>';
    return;
  }

  for (const proposal of result.proposals) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm btn--primary">Approve</button>
        <button class="btn btn--sm btn--ghost">Reject</button>
      </div>`;
    row.querySelector('.row__title').textContent = proposal.summary;
    row.querySelector('.row__sub').textContent = proposal.kind === 'trip_cluster' ? 'Trip' : 'Camera correction';

    row.querySelector('.btn--primary').addEventListener('click', async () => {
      const r = await window.lanshare.patternEngine.approve(proposal.id);
      if (!r.ok) { alert(r.error); return; }
      await loadAutomation();
    });
    row.querySelector('.btn--ghost').addEventListener('click', async () => {
      const r = await window.lanshare.patternEngine.reject(proposal.id);
      if (!r.ok) { alert(r.error); return; }
      await loadGhostQueue();
    });
    container.append(row);
  }
}

async function loadGhostApproved() {
  const result = await window.lanshare.patternEngine.proposals('approved');
  const container = $('ghostApprovedList');
  container.textContent = '';
  if (!result.ok || !result.proposals?.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">Nothing approved yet.</p>';
    return;
  }

  for (const proposal of result.proposals.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row__main">
        <div class="row__title"></div>
        <div class="row__sub"></div>
      </div>
      <div class="row__actions">
        <button class="btn btn--sm btn--danger">Revert</button>
      </div>`;
    row.querySelector('.row__title').textContent = proposal.summary;
    row.querySelector('.row__sub').textContent = proposal.decidedAt ? new Date(proposal.decidedAt).toLocaleString() : '';

    row.querySelector('.btn--danger').addEventListener('click', async () => {
      if (!confirm('Undo this? Its trust level will drop straight back to Ask.')) return;
      const r = await window.lanshare.patternEngine.revert(proposal.id);
      if (!r.ok) { alert(r.error); return; }
      await loadAutomation();
    });
    container.append(row);
  }
}

async function loadAuditLog() {
  const result = await window.lanshare.auditLog.list();
  const container = $('auditLogList');
  container.textContent = '';
  if (!result.ok || !result.entries?.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1rem">Nothing logged yet.</p>';
    return;
  }

  for (const entry of result.entries.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<div class="row__main"><div class="row__title"></div><div class="row__sub"></div></div>';
    row.querySelector('.row__title').textContent = `${entry.decision} — ${ACTION_TYPE_LABELS[entry.actionType] || entry.actionType}`;
    row.querySelector('.row__sub').textContent = new Date(entry.createdAt).toLocaleString();
    container.append(row);
  }
}

$('ghostScanBtn').addEventListener('click', async () => {
  $('ghostScanBtn').disabled = true;
  $('ghostScanNote').textContent = 'Scanning…';
  try {
    const result = await window.lanshare.patternEngine.scan();
    if (!result.ok) { $('ghostScanNote').textContent = result.error; return; }
    $('ghostScanNote').textContent = `Found ${result.proposed.length} new proposal(s), auto-attached ${result.autoAttached.length} file(s).`;
    await loadAutomation();
  } finally {
    $('ghostScanBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

/**
 * Shown before anything else on a fresh install.
 *
 * Until this is finished there is an admin password that was generated rather
 * than chosen, so the rest of the app would be misleading to touch — hence a
 * cover rather than a panel, and no way to dismiss it without finishing.
 */
async function loadSetup() {
  const state = await window.lanshare.setup.status();
  if (!state.needed) {
    $('setupOverlay').hidden = true;
    return;
  }

  $('setupOverlay').hidden = false;
  $('setupUsername').value = state.defaultUsername || 'admin';
  $('setupLibrary').value = state.libraryPath;
  renderFirewallStep(state);
  $('setupUsername').focus();
}

function renderFirewallStep(state) {
  const note = $('setupFirewallNote');
  const button = $('setupFirewallBtn');

  if (!state.firewall?.supported) {
    note.textContent = 'Nothing to do on this system — it does not block incoming '
      + 'connections on your own network by default.';
    button.hidden = true;
    return;
  }

  if (state.firewall.present) {
    note.textContent = 'Allowed. Other devices on your network can reach LANShare.';
    button.hidden = true;
    return;
  }

  note.textContent = 'Windows blocks incoming connections by default, which is the usual '
    + 'reason a phone cannot find LANShare even though it is running. This adds a rule for '
    + 'private networks only — never public ones — and Windows will ask you to confirm.';
  button.hidden = false;
}

$('setupBrowseBtn').addEventListener('click', async () => {
  const picked = await window.lanshare.pickFolder();
  if (picked) $('setupLibrary').value = picked;
});

$('setupFirewallBtn').addEventListener('click', async () => {
  const errorEl = $('setupFirewallError');
  errorEl.classList.remove('is-shown');

  const button = $('setupFirewallBtn');
  button.disabled = true;
  button.textContent = 'Waiting for Windows…';
  try {
    const result = await window.lanshare.setup.allowFirewall();
    if (!result.ok) {
      errorEl.textContent = result.error;
      errorEl.classList.add('is-shown');
      return;
    }
    renderFirewallStep(await window.lanshare.setup.status());
  } finally {
    button.disabled = false;
    button.textContent = 'Allow through the firewall';
  }
});

$('setupFinishBtn').addEventListener('click', async () => {
  const errorEl = $('setupError');
  errorEl.classList.remove('is-shown');

  const username = $('setupUsername').value.trim();
  const password = $('setupPassword').value;

  // Checked here as well as in the main process: this is the one password
  // that is reachable from every device on the network.
  if (!username) return showSetupError('Choose a username.', 'setupUsername');
  if (password.length < 8) return showSetupError('Use a password of at least 8 characters.', 'setupPassword');
  if (password !== $('setupPassword2').value) {
    return showSetupError('The two passwords do not match.', 'setupPassword2');
  }

  const button = $('setupFinishBtn');
  button.disabled = true;
  button.textContent = 'Setting up…';

  try {
    const result = await window.lanshare.setup.complete({
      username,
      password,
      libraryPath: $('setupLibrary').value,
      startOnLogin: $('setupStartOnLogin').checked,
    });

    if (!result.ok) return showSetupError(result.error);

    // Never leave the password sitting in a field.
    $('setupPassword').value = '';
    $('setupPassword2').value = '';
    $('setupOverlay').hidden = true;
    $('firstRunCard').hidden = true;
    await refresh();
  } catch (err) {
    showSetupError(`Setup could not finish: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = 'Finish setup';
  }
  return undefined;
});

/**
 * Show why the button did nothing.
 *
 * The message alone is not enough: it once rendered below the fold, so a
 * rejected password looked exactly like a dead button. Now the field at fault
 * is scrolled to and focused, so the reason is always somewhere the eye is
 * already going.
 */
function showSetupError(message, fieldId = null) {
  const errorEl = $('setupError');
  errorEl.textContent = message;
  errorEl.classList.add('is-shown');

  const field = fieldId && $(fieldId);
  if (field) {
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field.focus();
  }
  return undefined;
}

loadSetup();
