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
  vaults: () => loadVaults(),
  library: () => loadLibrary(),
  sync: () => loadSync(),
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
window.lanshare.sync.onChanged(({ running }) => {
  runningSyncIds.clear();
  for (const id of running || []) runningSyncIds.add(id);

  if (!$('panel-sync').classList.contains('is-active')) return;
  $('syncNote').textContent = running?.length
    ? 'A drive was connected — syncing automatically…'
    : '';
  loadSync();
});
