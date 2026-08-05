# LANShare — plan

Living document. Updated as work lands, not left to rot.

**What this is:** a personal storage network. Every machine — Windows, macOS,
Linux — runs the same app and can act as both host and client. Photos and
videos live on whichever machine you choose; any device browses them; some
albums are encrypted at rest; storage spans internal, external and cloud-mounted
drives; external drives sync when plugged in; and hosts reach each other over
the internet without port forwarding.

---

## Status

| Phase | What | State |
|---|---|---|
| — | Web gallery, media pipeline, PWA, single-file exe | **Done** |
| 0 | Repository workflow | **Done** (PRs pending `gh`, see below) |
| A | Desktop control panel, accounts, permissions, sessions | **Done** |
| B | Encrypted vaults | **Done** |
| C | Storage across drives | **Done** |
| D | Sync | Not started |
| E | macOS and Linux | Not started |
| F | Client mode — connect to other hosts | Not started |
| G | P2P over the internet | Not started |

---

## Working agreement

### Branches

```
main          stable, releasable
 └── dev      integration
      └── feat/… | fix/… | chore/…    one per task, branched from dev
```

Every task:

```bash
git checkout dev && git pull        # sync first, always
git checkout -b feat/short-name     # branch from dev
# ... work, commit ...
git push -u origin feat/short-name
gh pr create --base dev --fill
gh pr merge --squash --delete-branch
```

`main` only receives `dev` at a release point.

**Claude does not ask before merging a PR into `dev`.** Agreed 2026-08-04.
Merges into `main` are release decisions and are announced, not silent.

#### One-time setup still needed for real PRs

The GitHub CLI **is now installed** (2.97.0). The earlier hang was
`winget install` waiting on an elevation prompt a non-interactive shell
cannot answer; `--scope user` avoids it entirely:

```bash
winget install --id GitHub.cli -e --scope user
```

It still needs authenticating, which only you can do — it is an interactive
OAuth flow, and Claude will not ask for or accept a token:

```bash
gh auth login
```

Until then, every task still gets its own branch and is pushed, so nothing is
lost; only the pull request record on GitHub is missing. Once `gh auth status`
succeeds the workflow switches to `gh pr create` / `gh pr merge` with no other
changes.

**GitHub achievements** (a stated goal): the workflow already in use earns
several without gaming anything — **Pull Shark** from merging the stacked
PRs, **YOLO** from merging without review (already the agreed process), and
**Quickdraw** from opening an issue and closing it within five minutes. The
401→403 vault-unlock bug found in Phase B is a legitimate candidate for that
last one: a real bug, found by real testing, already fixed. Not worth
chasing: **Pair Extraordinaire** needs a co-author who is a real GitHub
account (the commit trailer here is a noreply address, and real people should
not be credited for commits they did not write), and **Starstruck** needs
genuine stars.

The remote is also still named `file-shairing`. Rename it in GitHub → Settings,
then `git remote set-url origin <new-url>`.

### Files

- `instruction.md` — your inbox. Entries are treated as prompts, acted on,
  then deleted. Anything durable lands here in `plan.md` first.
- `plan.md` — this file.

### Testing

Security boundaries get automated tests, because clicking through a UI does not
prove them. Current suites, all run against a live server:

| Suite | Covers |
|---|---|
| `test/smoke.mjs` | auth, path traversal, range requests, upload round-trip, albums, trash, zip |
| `test/media.mjs` | thumbnails, metadata, HEVC detection, live transcoding |
| `test/pwa.mjs` | HTTPS and every PWA install requirement |
| `test/throughput.mjs` | 1 GB round trip with end-to-end checksum |
| `test/permissions.mjs` | per-role capability, album scoping, session revocation, immediate disable, last-admin lockout protection |
| `test/migration.mjs` | a pre-roles config.json still signs in and upgrades to admin |
| `test/library.mjs` | library stats, same-volume rename, a genuine cross-volume move (C:↔D: on this machine), nesting/non-empty-destination refusal with the source left untouched, cache/trash clearing |
| `test/vaultfile.mjs` | vault file round trips at every chunk boundary, eight byte-range shapes, and tamper detection: wrong key, flipped bit, dropped trailer, lopped-off final chunk, reordered chunks, a chunk grafted in from another file under the same key, altered header |
| `test/vault.mjs` | envelope encryption, multiple passphrases on one vault, cross-vault key-entry transplant refused, recovery codes, per-file keys, and end-to-end integration with the file format |
| `test/vaults.mjs` | album vaults: creation refusals, which vault owns a path (including nested), lock/unlock, real auto-lock expiry, key material never reaching disk |
| `test/vault-routes.mjs` | vaults over HTTP: encrypted upload/download, ranges in plaintext offsets, locked albums revealing nothing, key sharing, and files crossing a vault boundary |
| `test/e2e-crypto.mjs` | the browser and server crypto implementations agreeing byte-for-byte in both directions |
| `test/volumes.mjs` | identifying a volume by GUID, surviving a changed drive letter, longest-mount-point matching |
| `test/locations.mjs` | albums living on other drives: real cross-volume relocation, link removal guards, dangling links, a self-referential link not looping a walk, and a failed bring-home leaving no hidden staging copy |
| `test/location-routes.mjs` | locations over HTTP: registering a drive, relocating an album, that album still downloading, listing, and accepting uploads on its original path, an unplugged drive surfacing as unreachable rather than empty, and reconnecting needing no repair step |
| `test/electron-links.js` | link creation and removal **inside an Electron runtime** — run with `npx electron test/electron-links.js`, not Node |

All 15 suites, 432 checks, pass together as of the Phase C merge.
(`test/pwa.mjs` and `test/throughput.mjs` are run on demand rather than in
the standard sweep — one needs the HTTPS listener, the other moves a
gigabyte. `test/electron-links.js` needs an Electron runtime, for the reason
recorded under Phase C below.)

**Desktop app status:** Electron control panel with five working screens
(Status, Accounts, Devices, Library, Settings), packaged as a Windows
installer (`npm run build:desktop` → NSIS, ~213 MB) via electron-builder.
Verified end to end against both the dev app and the actual packaged
win-unpacked build — accounts created via the UI sign in over the real HTTP
API, revoking a session in Devices actually 401s that cookie, changing the
port in Settings actually restarts the server, and moving the library
relocates it, survives the restart, and leaves the server fully working from
the new location. Not yet tested on macOS/Linux (Phase E).

**Post-hoc audit (2026-08-04):** re-read every Phase A file critically rather
than just rerunning the already-passing suites, and found real bugs the
tests hadn't thought to check for:

- A root typed with a trailing slash (`"Family/"` — an ordinary thing to
  type) locked that account out of its own root folder, since `resolveSafe()`
  never returns a trailing slash for the folder itself. Fixed by normalizing
  roots at the point of storage (`normalizeRootPath()` in `lib/paths.js`,
  matching `resolveSafe()`'s own normalization exactly), not just validating
  their shape.
- `sessions.revokeAllForUser()`/`list()` compared usernames case-sensitively
  while every other comparison in the codebase is case-insensitive —
  deleting an account via a differently-cased route param left its session
  record behind. Not an access-control bypass (`requireAuth` independently
  re-validates the account exists on every request regardless), but a real
  bookkeeping bug. Fixed to match.
- `startServer`/`stopServer` in `desktop/main.js` were not serialized — two
  operations landing close together (Settings saving a port change while a
  Library move's restart was still in flight) could race to bind the same
  port twice. Added a minimal `serialize()` queue; confirmed fixed by firing
  5 concurrent start/stop calls and a settings-update-racing-restart via CDP
  against the live app — no double-binds, consistent final state, still
  reachable over real HTTP afterward.

None of these were caught by the original test suites because the tests
checked behavior I had already thought to check. **Lesson for future
audits:** rerunning existing tests proves no regression; it does not prove
absence of bugs the tests were never written to catch. An audit needs to
re-read the code, not just re-run it.

**Testing note for future sessions:** in this environment, Windows UI
Automation's accessibility tree can be unreliable against a freshly launched
packaged (asar-loaded) renderer — it reported an almost-empty tree that looked
like a rendering failure, while Chrome DevTools Protocol against the same
process showed a fully populated, correct DOM with no errors. When verifying
an Electron window here, prefer connecting over CDP
(`--remote-debugging-port`) over UI Automation or screen capture, both of
which have independently produced misleading results.

---

## Phase B — encrypted vaults (done)

Both vault types work end to end:

- **Server-unlock vaults** keep every media feature — thumbnails, previews,
  video scrubbing — because the server can decrypt while unlocked. Vault
  thumbnails are themselves encrypted at rest, or the cache would be a
  plaintext gallery of exactly what the vault protects.
- **End-to-end vaults** are encrypted in the browser; the server holds no key
  and cannot read them. The cost, stated up front at creation rather than
  discovered later: no thumbnails, no previews, no video playback — downloads
  only. `public/vaultcrypto.js` is a second implementation of the same format
  against WebCrypto, and `test/e2e-crypto.mjs` guards the drift risk by
  encrypting with each side and decrypting with the other.

**Known limitation, deliberate and recorded:** file names, folder structure,
sizes and timestamps are not encrypted in either vault type — only contents.
Someone with a stolen drive can see an album holds `passport-scan.jpg` of
2.4 MB. Fixing it means opaque on-disk ids plus an encrypted manifest, which
touches listing, sorting, thumbnails, rename, move and zip — worth doing as
its own piece rather than half-doing here.

**Audit after the fact found four vault-blind routes**, none caught by the
then-green suite. The worst: `/api/move` across a vault boundary was silent
data loss — a file moved out of a vault reported success and left an
undecryptable blob. Also `/api/zip` archived ciphertext, `/api/meta` reported
the encrypted size, and `/api/delete` trashed vault files outside the only
vault that could decrypt them. All fixed with 17 regression tests. **The bugs
lived in the seam between two well-tested areas** — vault routes and plain
routes were each covered; nothing covered a file crossing between them. That
is the second time an audit found what tests could not (see the Phase A note
above).

A flaw caught while writing the key layer, recorded because it is the kind
that passes a careless test: the first `unlockWithRecoveryCode` "verified" a
code by wrapping and then unwrapping a probe with that same key. That always
succeeds regardless of the key, so it proved nothing — any 32 random bytes
would have appeared to unlock the vault and then failed incomprehensibly on
the first file. A recovery code *is* the master key, so there is nothing to
unwrap to prove it; vaults now store a `check` blob (a known value encrypted
under the master key at creation) and codes are verified against that.

---

## Phase C — storage across drives (done)

An album can live on another drive while keeping its place in the library.

**How it works.** The album's contents move to the other drive and a
**directory junction** takes its place in the library (a symlink on
macOS/Linux). Everything above the filesystem — listing, download, upload,
thumbnails, vaults, zip — keeps working on the original path with no changes,
because as far as those routes are concerned nothing moved. Junctions need no
administrator rights on Windows, which was verified before the design was
built on them.

Drives are tracked by **volume GUID, not drive letter**, so an external disk
that comes back as `F:` instead of `E:` is still recognised. `repairLinks()`
runs at startup and repoints any album whose drive moved; it logs what it
repaired and what is still broken, and never prevents startup.

The move itself is copy → verify bytes and file count → remove the source →
create the link, and it rolls back if the link cannot be created. Bringing an
album home is the same in reverse. Google Drive needs no integration: with
Drive for Desktop installed, `G:\…` is just another location, and encrypted
albums arrive there already encrypted.

**Three bugs found by testing the wiring rather than the parts**, all with
every existing suite green:

- `/api/list` used `entry.isDirectory()`, which is **false for a junction** —
  a relocated album was listed as a *file*, and one on an unplugged drive
  vanished from the listing altogether. Now it asks the resolved stat, and an
  unreachable album is still listed and marked unreachable, which is the whole
  point of tracking where it went. `locations:albums` in the desktop app had
  the identical blind spot, which hid exactly the albums the screen exists to
  bring back.
- **`fs.rmSync` on a junction works under Node and throws `EISDIR` under
  Electron** (its asar shim stats through the link). Bringing an album home
  therefore passed every HTTP test and failed in the actual desktop app. Fixed
  to `rmdirSync` on Windows / `unlinkSync` on POSIX, which behave the same in
  both runtimes. **This is why `test/electron-links.js` exists and runs under
  Electron** — a Node-hosted test cannot see this class of bug, and the
  desktop app is the only place this code really runs.
- A failed bring-home left its `.incoming-*` staging folder behind — a full
  hidden duplicate of the album, invisible in the gallery. Now cleaned up and
  relinked on any failure, with an injected-failure test.

The renderer had a matching gap: an IPC rejection left the status note on
"Copying…" forever with nothing saying why. Both directions now surface the
error.

---

## Decisions and why

Recorded so they are not relitigated or quietly reversed.

| Decision | Reasoning |
|---|---|
| Default port **8420**, not 8080 | An AirPlay receiver holds 8080 on the Windows machine |
| Both HTTP and HTTPS listeners | HTTP is fastest and simplest on a LAN; Chrome and Edge only offer PWA install over HTTPS |
| Native `loading="lazy"` for thumbnails | An IntersectionObserver has a failure mode that leaves the entire grid blank; native lazy loading does not |
| `requestTimeout = 0` | Node's 5-minute default silently truncates multi-gigabyte uploads |
| Deletes go to trash, never unlink | A mistaken tap on a phone must be recoverable |
| Safari gets original HEIC and HEVC | Apple devices decode both natively; converting would cost quality and CPU for nothing |
| Everyone else gets transcoded HEVC | Chrome, Firefox and Android cannot decode it, and a black rectangle is not a video player |
| Volume **GUID**, not drive letter | Letters and mount points change between plug-ins |
| Google Drive via Drive for Desktop | It is already a mounted folder; direct API integration needs a Google Cloud project and OAuth consent for no real gain |
| PBKDF2-HMAC-SHA512 for vault keys | scrypt is stronger, but WebCrypto has no scrypt and end-to-end vaults must derive the same key in a browser. One shared derivation beats the margin |
| Vaults chunked at 1 MiB, AES-256-GCM | Whole-file encryption would break video seeking; chunking keeps range requests working |
| Sessions stored in `.lanshare-server/`, next to config.json | Not under `library/` — sessions must stay reachable even after the library moves to another drive (Phase C) |
| Roles/sessions checked fresh on every request | The old stateless HMAC token kept validating on its own for up to 30 days; a demoted or disabled account must lose access immediately |
| `config` object mutated in place, never replaced wholesale | `requireAuth`'s closure holds one reference for the process lifetime; `config = {...}` would silently detach it from later account edits |
| `/api/list` resolves the request path loosely before scoping it | A restricted account's "/" is virtual — not literally inside any of its own roots — so the strict per-account check must not run against it, only against real paths |
| Cannot disable, demote or delete the last enabled admin | Otherwise there would be nobody left with permission to undo the mistake |
| Encrypted albums sync as ciphertext | Never decrypting to copy is what makes a lost drive or a cloud copy safe |
| Two-way sync compares **three** states | Without a baseline snapshot, "deleted here" and "added there" are indistinguishable and deleted files come back |
| A random vault master key, wrapped per passphrase — never derived from one | Lets one vault hold several passphrases and recovery codes as list entries, so granting or rotating access never re-encrypts the album |
| Chunk AAD binds header hash + index + end-of-file flag | Independent chunks are the point of the format and also its danger: without this, chunks could be reordered, grafted in from another file under the same key, or the file truncated, and every remaining chunk would still authenticate |
| Plaintext length in an encrypted trailer, not the header | The length is unknown until an upload finishes streaming, by which point the header is already sealed into every chunk's AAD. At the end, it also makes truncation-to-zero-chunks detectable rather than looking like an empty file |
| Per-file keys, not one key per vault | Restarts the chunk nonce counter safely for every file |
| Vault stores a `check` blob | A recovery code *is* the master key, so nothing unwraps to prove it. Without a stored verifier, any 32 random bytes appear to unlock the vault and fail later on the first file |

---

## Open questions

Decide before the phase that needs them.

- **Phase E — macOS signing.** Shipping unsigned means Gatekeeper blocks the
  DMG until opened via right-click → Open. Notarising needs an Apple Developer
  account ($99/yr). Apple policy; no code can work around it.
- **Phase G — P2P infrastructure.** NAT traversal cannot bootstrap from
  nothing. Either run a small rendezvous server plus a TURN relay on a cheap
  VPS, or install Tailscale on each machine and skip the phase entirely with
  no code at all. Worth deciding before the work starts, not after.

---

## Phases

Detail lives in the approved plan; summarised here so this file stands alone.

**0 — Workflow.** Branches, `plan.md`, `instruction.md`, GitHub CLI so PRs can
be opened and merged.

**A — Desktop control panel.** Electron app owning the server. Accounts with
cumulative roles (viewer → contributor → manager → admin) and per-account album
restrictions; revocable sessions with a device list; library location and move;
settings including close-to-tray and start-on-login. Also removes the current
~10 s startup, since ffmpeg stops being Brotli-packed.

*Migration risk:* an existing `config.json` user has no role and must default to
admin, or first launch locks you out of your own library.

**B — Encrypted vaults.** Per-album, two kinds. *Server-unlock* keeps
thumbnails, previews and streaming working. *End-to-end* means the server only
ever holds ciphertext and those albums are download-only — inherent, not a gap.
Envelope encryption with a per-vault master key wrapped once per passphrase,
which is what makes key sharing work without re-encrypting. Sharing a key
cannot be undone.

**C — Storage across drives.** The library becomes a set of locations; the
gallery merges albums across them so browsing is unchanged.

**D — Sync.** Per target: albums, direction, conflict policy (keep both /
newest wins / mirror), and whether to run on connect. Target deletions go to
trash there. Dry run and log every time.

**E — macOS and Linux.** Autostart, volume detection, tray and packaging differ
per platform; the rest is shared.

**F — Client mode.** Connect to other hosts, browse their libraries, copy
between any two. mDNS on the LAN, pairing code elsewhere. Credentials in the OS
keychain.

**G — P2P.** Rendezvous server for introductions, direct WebRTC where possible,
TURN relay when NAT refuses. End-to-end encrypted regardless of path, so relay
and rendezvous see ciphertext only.
