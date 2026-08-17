/* =========================================================================
   LANShare client
   ========================================================================= */
'use strict';

const state = {
  path: '/',
  folders: [],
  files: [],
  selected: new Set(),
  sort: localStorage.getItem('lanshare.sort') || 'newest',
  viewerIndex: -1,
  // The vault covering the current folder, if any: { path, type, locked }.
  vault: null,
  // Search replaces state.folders/files with results spanning every album
  // this account can reach, rather than just the current one. state.path
  // itself is left untouched while searching, so clearing the search is
  // just re-navigating to wherever browsing was left off.
  searching: false,
  searchQuery: '',
  // 'text' matches names and metadata (GET /api/search); 'content' asks a
  // local model what a photo actually shows (GET /api/search/content,
  // Phase N). Toggled by #searchKindBtn, which stays hidden entirely unless
  // contentSearchAvailable below is true.
  searchKind: 'text',
  // Set once at boot via /api/me. The server enforces every role boundary
  // regardless — this exists only so an action nobody but an admin could
  // ever complete is not offered to begin with.
  role: null,
  // Also from /api/me: whether GET /api/search/content has anything to
  // search yet. False until an admin has built the index at least once.
  contentSearchAvailable: false,
};

/**
 * Master keys for end-to-end vaults, held in this tab's memory only.
 *
 * The server has no key for these albums and never will, so unlocking them
 * happens here. Deliberately not sessionStorage or localStorage: a key that
 * outlives the tab is a key sitting on disk in the browser profile, which
 * would undo most of the point. Closing the tab locks the album.
 */
const e2eKeys = new Map(); // vault album path -> Uint8Array master key

const hasWebCrypto = () => Boolean(window.LanShareVault?.available);

const $ = (id) => document.getElementById(id);
const q = encodeURIComponent;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  return `${Math.ceil(seconds / 60)}m left`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body && !(options.body instanceof FormData)
      ? { 'content-type': 'application/json', ...(options.headers || {}) }
      : options.headers,
  });

  if (res.status === 401) {
    location.href = `/login?next=${q(location.pathname + location.search)}`;
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const postJson = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast${kind ? ` toast--${kind}` : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    setTimeout(() => el.remove(), 300);
  }, 3400);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function sortFiles(files) {
  const sorted = [...files];
  switch (state.sort) {
    case 'oldest': return sorted.sort((a, b) => a.mtime - b.mtime);
    case 'name': return sorted.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }));
    case 'largest': return sorted.sort((a, b) => b.size - a.size);
    default: return sorted.sort((a, b) => b.mtime - a.mtime);
  }
}

function renderCrumbs() {
  const crumbs = $('crumbs');
  crumbs.textContent = '';

  const segments = state.path.split('/').filter(Boolean);
  const makeLink = (label, target, isCurrent) => {
    const btn = document.createElement('button');
    btn.className = 'crumbs__link';
    btn.textContent = label;
    if (isCurrent) btn.setAttribute('aria-current', 'page');
    else btn.addEventListener('click', () => navigate(target));
    return btn;
  };

  crumbs.append(makeLink('Library', '/', segments.length === 0));

  let accumulated = '';
  segments.forEach((segment, index) => {
    accumulated += `/${segment}`;
    const sep = document.createElement('span');
    sep.className = 'crumbs__sep';
    sep.textContent = '/';
    crumbs.append(sep, makeLink(segment, accumulated, index === segments.length - 1));
  });
}

/**
 * Varied tile spans. The brief rules out equal columns, and the pattern is
 * driven by index so a given folder always lays out the same way.
 */
function spanClass(index) {
  const cycle = index % 11;
  if (cycle === 0) return ' tile--big';
  if (cycle === 4) return ' tile--wide';
  if (cycle === 7) return ' tile--tall';
  return '';
}

function buildTile(file, index, { searchMode = false } = {}) {
  const tile = document.createElement('article');
  tile.className = `tile${spanClass(index)}${searchMode ? ' tile--search' : ''}`;
  tile.dataset.path = file.path;
  tile.style.animationDelay = `${Math.min(index, 12) * 40}ms`;

  // The location whose name/path/etc. this file object actually describes.
  // "Remote-only" means the best copy search knows of is not on this server
  // at all — nothing here can thumbnail, preview or download it, only say
  // where it actually lives.
  const primary = searchMode ? primaryLocation(file) : null;
  const isRemoteOnly = Boolean(primary && primary.source !== 'local');
  const otherLocations = searchMode && file.locations ? file.locations.length - 1 : 0;

  // An end-to-end vault's contents are ciphertext to the server, so there is
  // no thumbnail to ask for — requesting one would only produce a guaranteed
  // 409 per tile. A remote-only result is the same story for a different
  // reason: this server was never sent the bytes to make one from. Show the
  // generic icon straight away in both cases.
  const hasThumb = (file.kind === 'image' || file.kind === 'video') && !file.e2e && !isRemoteOnly;

  if (hasThumb) {
    const img = document.createElement('img');
    img.className = 'tile__img';
    img.alt = file.name;
    // Native lazy loading rather than an IntersectionObserver: the browser
    // handles deferral itself, and there is no failure mode where a missed
    // callback leaves the whole grid blank.
    img.loading = 'lazy';
    img.decoding = 'async';
    // ?t= stamps the URL with mtime so the immutable cache is always correct.
    img.src = `/api/thumb?path=${q(file.path)}&t=${file.v}`;
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => {
      img.classList.add('is-loaded');
      img.replaceWith(genericIcon(file));
    });
    tile.append(img);
  } else {
    tile.append(genericIcon(file));
  }

  const skeleton = document.createElement('div');
  skeleton.className = 'tile__skeleton';
  tile.append(skeleton);

  if (file.kind === 'video') {
    const play = document.createElement('div');
    play.className = 'tile__play';
    play.innerHTML = '<span><svg class="icon" viewBox="0 0 24 24"><use href="#i-play"/></svg></span>';
    tile.append(play);

    const badge = document.createElement('div');
    badge.className = 'tile__badge';
    badge.textContent = '·  ·';
    tile.append(badge);
    // Duration needs ffprobe, so fetch it only for tiles that exist.
    loadDuration(file, badge);
  }

  const name = document.createElement('div');
  name.className = 'tile__name';
  name.textContent = file.name;
  if (searchMode) {
    const parent = document.createElement('span');
    parent.className = 'tile__parent';
    parent.textContent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
    name.append(document.createElement('br'), parent);
  }
  tile.append(name);

  // A search result found inside a vault: the route already never returns
  // one from a locked vault, so anything encrypted here is either an
  // unlocked one or an end-to-end album. Either way, flag it rather than
  // pretend it is an ordinary file. A remote-only result gets the same
  // corner instead, since only one of the two things this app cannot show
  // inline is ever true for a given tile at a time.
  if (searchMode && isRemoteOnly) {
    const away = document.createElement('div');
    away.className = 'tile__lock';
    away.title = primary.reachable
      ? `On ${primary.label} — not this machine`
      : `On ${primary.label} — unreachable right now`;
    away.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-drive"/></svg>';
    tile.append(away);
  } else if (searchMode && file.encrypted) {
    const lock = document.createElement('div');
    lock.className = 'tile__lock';
    lock.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><use href="#i-lock"/></svg>';
    tile.append(lock);
  }

  // However many other machines also hold this exact file — worth knowing
  // before you delete what looks like the only copy.
  if (otherLocations > 0) {
    const count = document.createElement('div');
    count.className = 'tile__locations';
    const others = file.locations.filter((l) => l !== primary).map((l) => l.label);
    count.title = `Also on ${others.join(', ')}`;
    count.innerHTML = `<svg class="icon" viewBox="0 0 24 24"><use href="#i-drive"/></svg><span>${otherLocations + 1}</span>`;
    tile.append(count);
  }

  // Download, delete, move and rename all assume a path this server can
  // actually resolve — a remote-only result has no such path here, so it
  // is never made selectable for them in the first place, rather than
  // letting a bulk action fail confusingly on whichever items it reached.
  if (!isRemoteOnly) {
    const check = document.createElement('button');
    check.className = 'tile__check';
    check.setAttribute('aria-label', `Select ${file.name}`);
    check.innerHTML = '<svg class="icon" viewBox="0 0 24 24" style="width:1rem;height:1rem"><use href="#i-check"/></svg>';
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSelect(file.path);
    });
    tile.append(check);
  }

  tile.addEventListener('click', () => {
    if (state.selected.size) { toggleSelect(file.path); return; }
    if (searchMode && isRemoteOnly) {
      toast(primary.reachable
        ? `${file.name} is on ${primary.label}, not this machine — this screen can only show you where it is.`
        : `${file.name} is on ${primary.label}, last reachable ${new Date(primary.cachedAt).toLocaleString()}.`);
      return;
    }
    if (searchMode && file.encrypted) {
      // The route already never returns a path from a locked vault, but
      // whether the server can actually decrypt it for a preview (a
      // server-unlock vault) or never could (end-to-end) is not something
      // search results carry. Going to the album itself is correct either
      // way, and it is also how "which album is this actually in" gets
      // answered, which is half of what search is for.
      openResultInAlbum(file);
      return;
    }
    if (searchMode && file.kind !== 'image' && file.kind !== 'video') {
      // No in-app viewer renders anything else; asking it to try would just
      // show a broken image frame.
      window.location.href = `/api/file?path=${q(file.path)}&dl=1`;
      return;
    }
    // Nothing on the server can render a preview of an end-to-end file, so
    // opening the viewer would show a broken frame. Downloading and
    // decrypting here is the only thing that can actually work.
    if (file.e2e) { downloadE2eFile(file); return; }
    openViewer(state.files.indexOf(file));
  });

  // Long-press on a phone starts selection, matching the Photos app.
  let pressTimer = null;
  tile.addEventListener('pointerdown', () => {
    pressTimer = setTimeout(() => toggleSelect(file.path), 500);
  });
  for (const event of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove']) {
    tile.addEventListener(event, () => clearTimeout(pressTimer));
  }

  return tile;
}

function genericIcon(file) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;place-items:center;height:100%;color:var(--text-soft)';
  const iconId = file.kind === 'video' ? '#i-film' : '#i-image';
  wrap.innerHTML = `<svg class="icon" style="width:2.5rem;height:2.5rem" viewBox="0 0 24 24"><use href="${iconId}"/></svg>`;
  return wrap;
}

const durationCache = new Map();

async function loadDuration(file, badge) {
  if (durationCache.has(file.path)) {
    badge.textContent = durationCache.get(file.path);
    return;
  }
  try {
    const meta = await api(`/api/meta?path=${q(file.path)}`);
    const label = formatDuration(meta.duration) || formatBytes(file.size);
    durationCache.set(file.path, label);
    badge.textContent = label;
  } catch {
    badge.textContent = formatBytes(file.size);
  }
}

function render() {
  renderCrumbs();

  // For an end-to-end album the server cannot know whether it is unlocked —
  // it holds no key. Only this tab does, so lock state for those is decided
  // here.
  if (state.vault?.type === 'e2e') {
    state.vault.locked = !e2eKeys.has(state.vault.path);
  }

  const isLocked = Boolean(state.vault?.locked);

  // A locked vault replaces the whole grid with the unlock prompt. There is
  // nothing to show — the server does not send names, let alone contents.
  $('lockedSection').hidden = !isLocked;
  if (isLocked) {
    $('albumsSection').hidden = true;
    $('mediaSection').hidden = true;
    $('empty').hidden = true;
    // Empty them rather than only hiding them. Whatever was on screen before
    // belongs to a different album, and leaving it parked in a hidden
    // container is how it ends up flashing back into view later.
    $('mosaic').textContent = '';
    $('albums').textContent = '';
    $('lockedNote').textContent = state.vault.type === 'e2e'
      ? 'This album is end-to-end encrypted. Enter its passphrase to unlock it in this browser.'
      : 'Enter its passphrase to see what is inside.';
    $('unlockError').classList.remove('is-shown');
    syncVaultToolbar();
    return;
  }

  const albumsSection = $('albumsSection');
  const albums = $('albums');
  albums.textContent = '';

  /**
   * The line under an album's name. Both facts can be true at once, and a
   * locked album on a disconnected drive needs both said, because unlocking
   * it would not help.
   */
  function albumState(folder) {
    const parts = [];
    if (folder.vault) parts.push(folder.vault.locked ? 'Locked' : 'Unlocked');
    if (folder.storage) {
      if (!folder.storage.reachable) parts.push('Drive not connected');
      else if (folder.storage.location) parts.push(`On ${folder.storage.location}`);
      else parts.push('On another drive');
    }
    return parts.join(' · ');
  }

  if (state.folders.length) {
    albumsSection.hidden = false;
    $('albumCount').textContent = state.folders.length;
    state.folders.forEach((folder, index) => {
      // An album can be both a vault and stored elsewhere. Locked says more
      // about what you can do with it right now, so it wins the icon; being
      // away is then said in words underneath.
      const away = folder.storage;
      const unreachable = Boolean(away && !away.reachable);

      const btn = document.createElement('button');
      btn.className = `album${folder.vault ? ' album--vault' : ''}${unreachable ? ' album--away' : ''}`;
      btn.style.animation = `tile-in .54s var(--ease-out) ${Math.min(index, 8) * 60}ms both`;

      let iconId = '#i-folder';
      if (folder.vault) iconId = folder.vault.locked ? '#i-lock' : '#i-unlock';
      else if (away) iconId = away.reachable ? '#i-drive' : '#i-drive-off';

      btn.innerHTML = `
        <span class="album__icon"><svg class="icon" viewBox="0 0 24 24"><use href="${iconId}"/></svg></span>
        <span>
          <span class="album__name"></span>
          <span class="album__state"></span>
        </span>`;
      btn.querySelector('.album__name').textContent = folder.name;
      btn.querySelector('.album__state').textContent = albumState(folder);

      if (unreachable) {
        // Opening it would show an empty album and imply the photos are gone.
        // Naming the drive turns that into something the owner can act on.
        btn.addEventListener('click', () => {
          toast(away.location
            ? `${folder.name} is stored on ${away.location}. Connect that drive to open it.`
            : `${folder.name} is stored on a drive that is not connected.`);
        });
      } else {
        btn.addEventListener('click', () => navigate(folder.path));
      }
      albums.append(btn);
    });
  } else {
    albumsSection.hidden = true;
  }

  // Content-search results already carry the one order that means anything
  // for them — ranked by similarity to the query — and re-sorting by the
  // ordinary newest/oldest/name/largest picker would silently throw that
  // away (a "red car" query putting its best match last just because it
  // happened to be uploaded first). Every other view, including a plain
  // text search, keeps the picker's chosen order as before.
  if (!(state.searching && state.searchKind === 'content')) {
    state.files = sortFiles(state.files);
  }

  const mediaSection = $('mediaSection');
  const mosaic = $('mosaic');
  mosaic.textContent = '';

  $('mediaHeading').textContent = state.searching
    ? (state.searchKind === 'content' ? 'Photos like this' : 'Search results')
    : 'Photos & videos';

  if (state.files.length) {
    mediaSection.hidden = false;
    $('mediaCount').textContent = state.files.length;
    const fragment = document.createDocumentFragment();
    state.files.forEach((file, index) =>
      fragment.append(buildTile(file, index, { searchMode: state.searching })));
    mosaic.append(fragment);
  } else {
    mediaSection.hidden = true;
  }

  const isEmpty = !state.folders.length && !state.files.length;
  $('empty').hidden = !isEmpty;
  if (isEmpty) {
    if (state.searching) {
      $('emptyTitle').textContent = 'No matches';
      $('emptyNote').textContent = state.searchKind === 'content'
        ? `Nothing looked like "${state.searchQuery}" — try describing it differently.`
        : `Nothing found for "${state.searchQuery}".`;
      $('emptyUploadBtn').hidden = true;
    } else {
      $('emptyTitle').textContent = 'Nothing here yet';
      $('emptyNote').textContent = 'Add photos and videos from this device, or from your phone by '
        + 'opening this same address there.';
      $('emptyUploadBtn').hidden = false;
    }
  }
  syncVaultToolbar();
  syncSelectionUi();
}

/**
 * "New vault" only makes sense in a folder that is not already inside one —
 * a vault within a vault is legal but confusing to offer by default. "Lock"
 * only makes sense when there is something unlocked to lock.
 */
function syncVaultToolbar() {
  // These are all about the current folder, which search results are not
  // scoped to — a result spans every album the account can reach.
  if (state.searching) {
    $('newVaultBtn').hidden = true;
    $('newE2eVaultBtn').hidden = true;
    $('newAlbumBtn').hidden = true;
    $('lockVaultBtn').hidden = true;
    // The sort picker has nothing to act on in content-search mode — its
    // one meaningful order is similarity, not newest/oldest/name/largest —
    // so it is hidden rather than left offering a choice that silently does
    // nothing, same reasoning as render() itself skipping sortFiles() there.
    $('sort').hidden = state.searchKind === 'content';
    return;
  }
  $('sort').hidden = false;
  const inVault = Boolean(state.vault);
  $('newVaultBtn').hidden = inVault;
  // A private album needs WebCrypto, which browsers only expose in a secure
  // context — so over plain HTTP on a LAN address this is genuinely
  // unavailable, and offering it would only produce a confusing failure.
  $('newE2eVaultBtn').hidden = inVault || !hasWebCrypto();
  $('newAlbumBtn').hidden = Boolean(state.vault?.locked);
  $('lockVaultBtn').hidden = !(inVault && !state.vault.locked);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

async function navigate(path, { push = true } = {}) {
  try {
    const data = await api(`/api/list?path=${q(path)}`);
    state.path = data.path;
    state.folders = data.folders;
    state.files = data.files;
    state.vault = data.vault || null;
    state.selected.clear();
    // Any real navigation — a crumb, an album, the back button — leaves
    // search results behind. Without this, the toolbar and section heading
    // would keep reporting "search results" for a folder that was reached
    // by clicking, not searching.
    if (state.searching) {
      state.searching = false;
      state.searchQuery = '';
      $('searchInput').value = '';
      $('searchClearBtn').hidden = true;
    }
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (push) history.pushState({ path: data.path }, '', `#${data.path}`);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

window.addEventListener('popstate', () => {
  navigate(decodeURIComponent(location.hash.slice(1)) || '/', { push: false });
});

// ---------------------------------------------------------------------------
// Search
//
// Deliberately left out of the URL/history model that folders use: a search
// is a transient lens over the whole library, not a place, so there is
// nothing meaningful to deep-link or to go "back" to beyond wherever
// browsing was left off. state.path is never touched while searching, so
// leaving it is always just re-navigating there.
// ---------------------------------------------------------------------------

function searchResultToFile(row) {
  return {
    name: row.name,
    path: row.path,
    kind: row.kind,
    size: row.size,
    mtime: row.mtime,
    encrypted: row.encrypted,
    v: Math.round(row.mtime || 0),
    // Present only when this account can see federated results at all
    // (search-routes.mjs's non-admin case omits it entirely, same as a
    // plain, unfederated /api/list file never having one) — always treated
    // as "just this one place" when absent, never as "nothing is known".
    locations: row.locations || null,
    // Content search only (Phase N) — a cosine similarity, not a boolean
    // match, so results are ranked rather than merely "found".
    score: typeof row.score === 'number' ? row.score : null,
  };
}

/** Whichever location the top-level name/path/etc. above actually describe. */
function primaryLocation(file) {
  return file.locations?.find((l) => l.primary) || file.locations?.[0] || null;
}

async function runSearch(text) {
  state.searching = true;
  state.searchQuery = text;
  state.selected.clear();
  try {
    const data = state.searchKind === 'content'
      ? await api(`/api/search/content?q=${q(text)}`)
      : await api(`/api/search?q=${q(text)}`);
    state.folders = [];
    state.files = data.results.map(searchResultToFile);
    state.vault = null;
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/** Re-runs the current search, or refreshes the current folder when not searching. */
function refreshView() {
  return state.searching ? runSearch(state.searchQuery) : navigate(state.path, { push: false });
}

function clearSearch() {
  navigate(state.path, { push: false });
}

function openResultInAlbum(file) {
  navigate(file.path.slice(0, file.path.lastIndexOf('/')) || '/');
}

let searchDebounce = null;

$('searchInput').addEventListener('input', (event) => {
  const text = event.target.value;
  $('searchClearBtn').hidden = !text;
  clearTimeout(searchDebounce);
  if (!text.trim()) {
    if (state.searching) clearSearch();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(text.trim()), 300);
});

$('searchInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  clearTimeout(searchDebounce);
  const text = event.target.value.trim();
  if (text) runSearch(text);
});

$('searchClearBtn').addEventListener('click', () => clearSearch());

$('searchKindBtn').addEventListener('click', () => {
  state.searchKind = state.searchKind === 'content' ? 'text' : 'content';
  const isContent = state.searchKind === 'content';
  $('searchKindBtn').setAttribute('aria-pressed', String(isContent));
  $('searchInput').placeholder = isContent
    ? 'Describe what\'s in the photo…' : 'Search your library';
  const text = $('searchInput').value.trim();
  if (text) runSearch(text);
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function toggleSelect(path) {
  if (state.selected.has(path)) state.selected.delete(path);
  else state.selected.add(path);
  syncSelectionUi();
}

function syncSelectionUi() {
  const count = state.selected.size;
  $('actionbar').classList.toggle('is-open', count > 0);
  $('selCount').textContent = count === 1 ? '1 item' : `${count} items`;
  document.body.classList.toggle('is-selecting', count > 0);
  // Only one item at a time can be renamed.
  $('selRename').disabled = count !== 1;

  for (const tile of document.querySelectorAll('.tile')) {
    tile.classList.toggle('is-selected', state.selected.has(tile.dataset.path));
  }
}

$('selClear').addEventListener('click', () => {
  state.selected.clear();
  syncSelectionUi();
});

$('selDelete').addEventListener('click', async () => {
  const paths = [...state.selected];
  const label = paths.length === 1 ? 'this item' : `these ${paths.length} items`;
  if (!confirm(`Move ${label} to the trash folder?`)) return;

  try {
    await postJson('/api/delete', { paths });
    toast(paths.length === 1 ? 'Moved to trash' : `${paths.length} moved to trash`, 'good');
    state.selected.clear();
    await refreshView();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('selRename').addEventListener('click', async () => {
  const [path] = [...state.selected];
  if (!path) return;
  const current = path.split('/').pop();
  const name = prompt('New name', current);
  if (!name || name === current) return;

  try {
    await postJson('/api/rename', { path, name });
    toast('Renamed', 'good');
    state.selected.clear();
    await refreshView();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('selMove').addEventListener('click', async () => {
  const target = prompt('Move into which album?\nType a folder path, or / for the top level.',
    state.path);
  if (target === null) return;

  try {
    const result = await postJson('/api/move', { paths: [...state.selected], to: target });
    if (result.failures.length) toast(result.failures[0].error, 'bad');
    else toast('Moved', 'good');
    state.selected.clear();
    await refreshView();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

$('selDownload').addEventListener('click', async () => {
  const paths = [...state.selected];
  try {
    if (paths.length === 1 && state.files.some((f) => f.path === paths[0])) {
      // A single file downloads directly, with no zip overhead.
      window.location.href = `/api/file?path=${q(paths[0])}&dl=1`;
    } else {
      const job = await postJson('/api/zip-prepare', { paths });
      window.location.href = job.url;
    }
    toast('Download started', 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
});

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const viewer = $('viewer');
const stage = $('viewerStage');

function currentItem() {
  return state.files[state.viewerIndex];
}

async function openViewer(index) {
  if (index < 0 || index >= state.files.length) return;
  state.viewerIndex = index;
  viewer.classList.add('is-open');
  document.body.style.overflow = 'hidden';
  await paintViewer();
}

function closeViewer() {
  viewer.classList.remove('is-open');
  document.body.style.overflow = '';
  clearStage();
  state.viewerIndex = -1;
}

function clearStage() {
  for (const el of stage.querySelectorAll('img, video, .viewer__spinner')) {
    if (el.tagName === 'VIDEO') {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    el.remove();
  }
}

async function paintViewer() {
  const file = currentItem();
  if (!file) return;

  clearStage();
  $('viewerTitle').textContent = file.name;
  $('viewerHint').textContent = `${formatBytes(file.size)} · ${new Date(file.mtime).toLocaleString()}`;

  if (file.kind === 'video') {
    const note = document.createElement('p');
    note.className = 'viewer__spinner';
    note.textContent = 'Preparing video…';
    stage.append(note);

    let playback;
    try {
      playback = await api(`/api/playback?path=${q(file.path)}`);
    } catch {
      playback = { url: `/api/file?path=${q(file.path)}`, direct: true };
    }
    // A different item may have been opened while we were waiting.
    if (currentItem() !== file) return;
    note.remove();

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.preload = 'metadata';
    // Without playsinline, iOS takes video fullscreen and out of the layout.
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.src = playback.url;
    stage.append(video);

    if (!playback.direct) {
      $('viewerHint').textContent +=
        ' · converting for this browser, seeking may be limited';
    }
  } else {
    const img = document.createElement('img');
    img.alt = file.name;
    img.src = `/api/preview?path=${q(file.path)}&t=${file.v}`;
    img.addEventListener('error', () => {
      img.src = `/api/file?path=${q(file.path)}`;
    });
    stage.append(img);
  }
}

function step(delta) {
  const next = state.viewerIndex + delta;
  if (next < 0 || next >= state.files.length) return;
  state.viewerIndex = next;
  paintViewer();
}

$('viewerClose').addEventListener('click', closeViewer);
$('viewerPrev').addEventListener('click', () => step(-1));
$('viewerNext').addEventListener('click', () => step(1));

$('viewerDownload').addEventListener('click', () => {
  const file = currentItem();
  if (file) window.location.href = `/api/file?path=${q(file.path)}&dl=1`;
});

$('viewerDelete').addEventListener('click', async () => {
  const file = currentItem();
  if (!file || !confirm(`Move "${file.name}" to the trash folder?`)) return;
  try {
    await postJson('/api/delete', { paths: [file.path] });
    toast('Moved to trash', 'good');
    closeViewer();
    await refreshView();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

document.addEventListener('keydown', (event) => {
  if (!viewer.classList.contains('is-open')) return;
  if (event.key === 'Escape') closeViewer();
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});

// Swipe between items on a touch screen.
let touchStartX = 0;
let touchStartY = 0;
stage.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) return;
  touchStartX = event.touches[0].clientX;
  touchStartY = event.touches[0].clientY;
}, { passive: true });

stage.addEventListener('touchend', (event) => {
  if (!touchStartX) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  touchStartX = 0;
  // Ignore mostly-vertical drags so pinch and scroll still feel natural.
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
  step(dx < 0 ? 1 : -1);
}, { passive: true });

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const uploadQueue = [];
let activeUploads = 0;
const MAX_PARALLEL = 3;
let totalQueued = 0;
let totalDone = 0;

function showUploadPanel() {
  $('uploads').classList.add('is-open');
}

$('uploadsClose').addEventListener('click', () => {
  $('uploads').classList.remove('is-open');
  $('uploadsList').textContent = '';
  totalQueued = 0;
  totalDone = 0;
});

function enqueue(file, relPath) {
  const row = document.createElement('div');
  row.className = 'upitem';
  row.innerHTML = `
    <div class="upitem__row">
      <span class="upitem__name"></span>
      <span class="upitem__stat">waiting</span>
    </div>
    <div class="upitem__track"><div class="upitem__fill"></div></div>`;
  row.querySelector('.upitem__name').textContent = relPath;
  $('uploadsList').append(row);

  uploadQueue.push({ file, relPath, row });
  totalQueued++;
  showUploadPanel();
  updateUploadTitle();
  pump();
}

function updateUploadTitle() {
  $('uploadsTitle').textContent = totalDone >= totalQueued
    ? `Added ${totalDone} ${totalDone === 1 ? 'item' : 'items'}`
    : `Uploading ${totalDone + 1} of ${totalQueued}`;
}

function pump() {
  while (activeUploads < MAX_PARALLEL && uploadQueue.length) {
    const job = uploadQueue.shift();
    activeUploads++;
    uploadOne(job).finally(() => {
      activeUploads--;
      totalDone++;
      updateUploadTitle();
      if (!activeUploads && !uploadQueue.length) {
        navigate(state.path, { push: false });
        toast('Upload complete', 'good');
      }
      pump();
    });
  }
}

async function uploadOne({ file, relPath, row }) {
  const fill = row.querySelector('.upitem__fill');
  const stat = row.querySelector('.upitem__stat');

  // Into an end-to-end album, encrypt here first. What leaves this browser
  // is already ciphertext; the server stores it untouched and could not
  // decrypt it if it wanted to.
  let payload = file;
  if (state.vault?.type === 'e2e') {
    const key = e2eKeyFor(state.vault.path);
    if (!key) {
      row.classList.add('is-error');
      stat.textContent = 'album is locked';
      return;
    }
    try {
      stat.textContent = 'encrypting…';
      const plaintext = new Uint8Array(await file.arrayBuffer());
      const ciphertext = await window.LanShareVault.encryptFile(plaintext, key);
      payload = new Blob([ciphertext]);
    } catch (err) {
      row.classList.add('is-error');
      stat.textContent = `encryption failed: ${err.message}`;
      return;
    }
  }

  return sendUpload({ payload, file, relPath, row, fill, stat });
}

function sendUpload({ payload, file, relPath, row, fill, stat }) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', payload, file.name);

    const xhr = new XMLHttpRequest();
    // XHR rather than fetch: only XHR reports upload progress.
    xhr.open('POST', `/api/upload?dir=${q(state.path)}&rel=${q(relPath)}`);

    const started = performance.now();
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const fraction = event.loaded / event.total;
      fill.style.width = `${fraction * 100}%`;
      const elapsed = (performance.now() - started) / 1000;
      const speed = event.loaded / Math.max(elapsed, 0.001);
      const remaining = (event.total - event.loaded) / Math.max(speed, 1);
      stat.textContent = `${formatSpeed(speed)} · ${formatEta(remaining)}`;
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        row.classList.add('is-done');
        fill.style.width = '100%';
        const elapsed = (performance.now() - started) / 1000;
        stat.textContent = `${formatBytes(file.size)} · ${formatSpeed(file.size / Math.max(elapsed, 0.001))}`;
      } else {
        row.classList.add('is-error');
        let message = `failed (${xhr.status})`;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch { /* keep the status message */ }
        stat.textContent = message;
      }
      resolve();
    });

    xhr.addEventListener('error', () => {
      row.classList.add('is-error');
      stat.textContent = 'connection lost';
      resolve();
    });

    xhr.addEventListener('abort', () => {
      row.classList.add('is-error');
      stat.textContent = 'cancelled';
      resolve();
    });

    xhr.send(form);
  });
}

$('uploadBtn').addEventListener('click', () => $('filePicker').click());
$('emptyUploadBtn').addEventListener('click', () => $('filePicker').click());

$('filePicker').addEventListener('change', (event) => {
  for (const file of event.target.files) enqueue(file, file.name);
  event.target.value = '';
});

$('folderPicker').addEventListener('change', (event) => {
  for (const file of event.target.files) {
    enqueue(file, file.webkitRelativePath || file.name);
  }
  event.target.value = '';
});

// --- drag and drop ---------------------------------------------------------
// Desktop only; iPhones and iPads have no drag-and-drop into a browser, which
// is why the Add button is always present rather than a drop hint.

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (![...event.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('dropzone').classList.add('is-active');
});

window.addEventListener('dragover', (event) => event.preventDefault());

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').classList.remove('is-active');
});

window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('is-active');

  const items = [...(event.dataTransfer.items || [])];
  const entries = items
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, '');
  } else {
    for (const file of event.dataTransfer.files) enqueue(file, file.name);
  }
});

/** Recurse into dropped folders so their structure is preserved. */
async function walkEntry(entry, prefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    enqueue(file, prefix + entry.name);
    return;
  }
  if (!entry.isDirectory) return;

  const reader = entry.createReader();
  // readEntries returns at most 100 per call, so keep going until it is empty.
  for (;;) {
    const batch = await new Promise((resolve, reject) =>
      reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walkEntry(child, `${prefix + entry.name}/`);
  }
}

// ---------------------------------------------------------------------------
// Albums, sorting, session
// ---------------------------------------------------------------------------

$('newAlbumBtn').addEventListener('click', async () => {
  const name = prompt('Name this album');
  if (!name) return;
  try {
    await postJson('/api/mkdir', { path: state.path, name });
    toast('Album created', 'good');
    await navigate(state.path, { push: false });
  } catch (err) {
    toast(err.message, 'bad');
  }
});

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

/**
 * Creating the album and encrypting it is one action rather than two,
 * because only an empty album can become a vault — offering "encrypt this
 * album" on an album you have already filled would just produce an error.
 */
$('newVaultBtn').addEventListener('click', async () => {
  const name = prompt('Name this encrypted album');
  if (!name) return;

  const passphrase = prompt(
    'Choose a passphrase for this vault.\n\n'
    + 'This is not your login password, and it is not stored anywhere. '
    + 'If you lose it, the contents cannot be recovered.',
  );
  if (!passphrase) return;
  if (passphrase.length < 8) {
    toast('That passphrase is too short — use at least 8 characters', 'bad');
    return;
  }
  if (prompt('Type the passphrase again to confirm') !== passphrase) {
    toast('Those did not match — nothing was created', 'bad');
    return;
  }

  try {
    await postJson('/api/mkdir', { path: state.path, name });
    const albumPath = state.path === '/' ? `/${name}` : `${state.path}/${name}`;
    await postJson('/api/vaults/create', { path: albumPath, passphrase });
    toast('Encrypted album created', 'good');
    await navigate(albumPath);
  } catch (err) {
    toast(err.message, 'bad');
    // The album may have been created before encryption failed; refresh so
    // the view matches reality rather than showing a folder that is not there
    // or hiding one that is.
    await navigate(state.path, { push: false });
  }
});

/**
 * A private (end-to-end) vault. The passphrase never leaves this browser
 * and the server never receives a key, so it genuinely cannot read the
 * contents — at the cost of no thumbnails, no previews and no video
 * streaming for that album. The prompt says so before anything is created.
 */
$('newE2eVaultBtn').addEventListener('click', async () => {
  if (!hasWebCrypto()) {
    toast('This browser cannot create private albums (no WebCrypto)', 'bad');
    return;
  }

  const name = prompt('Name this private album');
  if (!name) return;

  const passphrase = prompt(
    'Choose a passphrase for this private album.\n\n'
    + 'It never leaves this browser. The server cannot read these files at all, '
    + 'which also means no thumbnails, no previews and no video playback for '
    + 'this album — only downloads.\n\n'
    + 'If you lose the passphrase, nobody can recover the contents.',
  );
  if (!passphrase) return;
  if (passphrase.length < 8) {
    toast('That passphrase is too short — use at least 8 characters', 'bad');
    return;
  }
  if (prompt('Type the passphrase again to confirm') !== passphrase) {
    toast('Those did not match — nothing was created', 'bad');
    return;
  }

  try {
    await postJson('/api/mkdir', { path: state.path, name });
    const albumPath = state.path === '/' ? `/${name}` : `${state.path}/${name}`;
    await postJson('/api/vaults/create', { path: albumPath, passphrase, type: 'e2e' });
    // Unlock it here so the person can use it straight away, exactly as a
    // server-side vault starts unlocked after creation.
    await unlockE2eVault(albumPath, passphrase, false);
    toast('Private album created', 'good');
    await navigate(albumPath);
  } catch (err) {
    toast(err.message, 'bad');
    await navigate(state.path, { push: false });
  }
});

$('lockVaultBtn').addEventListener('click', async () => {
  if (!state.vault) return;
  try {
    if (state.vault.type === 'e2e') {
      // Nothing server-side to lock — the key only ever existed here.
      e2eKeys.delete(state.vault.path);
    } else {
      await postJson('/api/vaults/lock', { path: state.vault.path });
    }
    toast('Locked', 'good');
    await navigate(state.path, { push: false });
  } catch (err) {
    toast(err.message, 'bad');
  }
});

let unlockWithRecovery = false;

$('useRecoveryBtn').addEventListener('click', () => {
  unlockWithRecovery = !unlockWithRecovery;
  const field = $('unlockSecret');
  field.value = '';
  field.type = unlockWithRecovery ? 'text' : 'password';
  field.placeholder = unlockWithRecovery ? 'Recovery code' : 'Passphrase';
  field.autocomplete = unlockWithRecovery ? 'off' : 'current-password';
  $('useRecoveryBtn').textContent = unlockWithRecovery
    ? 'Use a passphrase instead'
    : 'Use a recovery code instead';
  field.focus();
});

$('unlockForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = $('unlockError');
  errorEl.classList.remove('is-shown');

  const secret = $('unlockSecret').value;
  if (!secret) return;

  $('unlockBtn').disabled = true;
  try {
    if (state.vault.type === 'e2e') {
      // The server cannot help here — it has no key. Fetch the wrapped
      // metadata and do the whole unlock in this tab.
      await unlockE2eVault(state.vault.path, secret, unlockWithRecovery);
    } else {
      await postJson('/api/vaults/unlock', {
        path: state.vault.path,
        ...(unlockWithRecovery ? { recoveryCode: secret } : { passphrase: secret }),
      });
    }
    $('unlockSecret').value = '';
    toast('Unlocked', 'good');
    await navigate(state.path, { push: false });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.add('is-shown');
    $('unlockSecret').select();
  } finally {
    $('unlockBtn').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// End-to-end vaults: everything below happens in this browser, never on the
// server, because for these albums the server has no key at all.
// ---------------------------------------------------------------------------

async function unlockE2eVault(albumPath, secret, isRecoveryCode) {
  if (!hasWebCrypto()) {
    throw new Error('This browser cannot open private albums (no WebCrypto). Try a modern browser over HTTPS.');
  }

  const { metadata } = await api(`/api/vaults/metadata?path=${q(albumPath)}`);
  const V = window.LanShareVault;

  let masterKey;
  if (isRecoveryCode) {
    masterKey = parseRecoveryCodeInBrowser(secret);
    await V.verifyMasterKey(metadata, masterKey);
  } else {
    masterKey = await V.unlockVault(metadata, secret);
  }

  e2eKeys.set(albumPath, masterKey);
}

/**
 * Crockford base32, matching lib/crypto/vault.js — including its tolerance
 * for the characters that alphabet leaves out, mapped to what someone
 * writing the code down clearly meant.
 */
function parseRecoveryCodeInBrowser(code) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const clean = String(code || '').toUpperCase().replace(/[\s-]/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');

  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index === -1) throw new Error('That recovery code contains invalid characters');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const bytes = new Uint8Array(out);
  if (bytes.length !== 32) throw new Error('That recovery code is not the right length');
  return bytes;
}

/** The in-memory key for whichever end-to-end vault covers this path. */
function e2eKeyFor(albumPath) {
  return e2eKeys.get(albumPath) || null;
}

/**
 * Download and decrypt an end-to-end file, then hand it to the browser as a
 * normal download. These albums are deliberately download-only: with no key
 * server-side there are no thumbnails, no previews and no video streaming,
 * which is the cost of the server genuinely not being able to read them.
 */
async function downloadE2eFile(file) {
  const key = e2eKeyFor(state.vault.path);
  if (!key) { toast('Unlock this album first', 'bad'); return; }

  toast('Decrypting…');
  try {
    const res = await fetch(`/api/file?path=${q(file.path)}`);
    if (!res.ok) throw new Error(`Could not fetch the file (${res.status})`);
    const ciphertext = new Uint8Array(await res.arrayBuffer());
    const plaintext = await window.LanShareVault.decryptFile(ciphertext, key);

    const url = URL.createObjectURL(new Blob([plaintext]));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    toast(err.message, 'bad');
  }
}

$('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  localStorage.setItem('lanshare.sort', state.sort);
  render();
});

$('signOutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

// ---------------------------------------------------------------------------
// Central index (Phase J) — reachable from any device, once set up: a
// shared passphrase and a relay address, walked through with the same
// prompt()-based flow a vault passphrase already uses rather than new UI
// chrome for something set up once and rarely touched again.
// ---------------------------------------------------------------------------

$('centralIndexBtn').addEventListener('click', async () => {
  try {
    const status = await api('/api/central-index/status');

    if (!status.configured) {
      const relayHost = prompt('Address of the relay every device will publish to (e.g. relay.example.com):');
      if (!relayHost) return;
      const relayPort = prompt('Relay port:', '8460');
      if (!relayPort) return;
      const passphrase = prompt(
        'Choose a passphrase.\n\n'
        + 'Type this same passphrase into every other device you want sharing this index. '
        + 'It never leaves any device unencrypted, and it is not stored anywhere but here.',
      );
      if (!passphrase) return;
      if (passphrase.length < 8) {
        toast('That passphrase is too short — use at least 8 characters', 'bad');
        return;
      }
      if (prompt('Type the passphrase again to confirm') !== passphrase) {
        toast('Those did not match — nothing was set up', 'bad');
        return;
      }
      await postJson('/api/central-index/setup', { relayHost, relayPort: Number(relayPort), passphrase });
      toast('Central index set up for this device', 'good');
      return;
    }

    const when = status.lastPublish
      ? `Last published from this device ${new Date(status.lastPublish.at).toLocaleString()} `
        + `(${status.lastPublish.entries} files).`
      : 'Not yet published from this device.';
    if (!confirm(`Central index is set up as "${status.label}".\n${when}\n\nPublish this device's index now?`)) return;

    const result = await postJson('/api/central-index/publish', {});
    toast(`Published ${result.entries} files to the central index`, 'good');
  } catch (err) {
    toast(err.message, 'bad');
  }
});

// ---------------------------------------------------------------------------
// Content search (Phase N) — building the index is the opt-in: nothing
// downloads or runs until an admin explicitly asks for it here, the same
// "nothing happens without a click" shape the central-index setup above
// has. The button's own label doubles as the progress readout while a build
// runs, the same way the rules screen's own preview/apply buttons show
// their progress inline rather than opening a separate panel for it.
// ---------------------------------------------------------------------------

let contentIndexPoll = null;

function stopContentIndexPoll() {
  clearInterval(contentIndexPoll);
  contentIndexPoll = null;
}

/**
 * Fetches the current build status once, updates the button accordingly,
 * and — only while a build is actually running — makes sure a polling
 * interval is ticking. Safe to call from anywhere (boot, after triggering a
 * build, on an interval tick) since it always leaves the interval in the
 * correct state for what it just observed, rather than assuming its caller
 * already knows whether one is running.
 */
async function checkContentIndexStatus() {
  try {
    const status = await api('/api/content-index/status');
    if (status.building) {
      $('contentIndexBtn').disabled = true;
      $('contentIndexBtnLabel').textContent = `Indexing… ${status.embedded}/${status.embeddable}`;
      if (!contentIndexPoll) contentIndexPoll = setInterval(checkContentIndexStatus, 1500);
      return;
    }
    stopContentIndexPoll();
    $('contentIndexBtn').disabled = false;
    $('contentIndexBtnLabel').textContent = 'Content search';
    const justBecameAvailable = !state.contentSearchAvailable && status.embedded > 0;
    state.contentSearchAvailable = status.embedded > 0;
    $('searchKindBtn').hidden = !state.contentSearchAvailable;
    if (justBecameAvailable) toast('Content search is ready', 'good');
  } catch {
    stopContentIndexPoll();
    $('contentIndexBtn').disabled = false;
    $('contentIndexBtnLabel').textContent = 'Content search';
  }
}

$('contentIndexBtn').addEventListener('click', async () => {
  try {
    const status = await api('/api/content-index/status');
    if (!status.building) {
      if (status.embeddable === 0) {
        toast('Add some photos or videos first — nothing to index yet', 'good');
        return;
      }
      const remaining = status.embeddable - status.embedded;
      if (remaining <= 0) {
        toast('Everything is already indexed for content search', 'good');
        return;
      }
      const downloadNote = status.modelCached
        ? ''
        : '\n\nThe first run downloads a local model (a few hundred MB) — this only happens once.';
      if (!confirm(`Index ${remaining} photo${remaining === 1 ? '' : 's'} for content search?${downloadNote}\n\n`
        + 'This runs in the background and can take a while for a large library.')) return;
      await postJson('/api/content-index/build', {});
    }
    await checkContentIndexStatus();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

$('sort').value = state.sort;

// The server enforces every role boundary regardless of what is shown here
// — this exists only so an admin-only action is not offered to an account
// that could never complete it.
api('/api/me').then((me) => {
  state.role = me.role;
  state.contentSearchAvailable = me.contentSearchAvailable;
  $('centralIndexBtn').hidden = me.role !== 'admin';
  $('contentIndexBtn').hidden = me.role !== 'admin';
  $('searchKindBtn').hidden = !me.contentSearchAvailable;
  // An admin whose index is already mid-build from a previous page load
  // (or another tab) should see that immediately, not just on next click.
  if (me.role === 'admin') checkContentIndexStatus();
}).catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Browsers refuse to register a worker over plain http on a LAN address,
  // so this quietly does nothing on the http listener.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

navigate(decodeURIComponent(location.hash.slice(1)) || '/', { push: false });
