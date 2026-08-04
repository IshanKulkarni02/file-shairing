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
| B | Encrypted vaults | Not started |
| C | Storage across drives | Not started |
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

The GitHub CLI is not installed and `winget install --id GitHub.cli` hangs on
this machine — it wants an elevation prompt that a non-interactive shell cannot
answer. Until it is installed, each task still gets its own branch, pushed, and
merged into `dev` with `--no-ff`, so history and branch structure are identical
to a squashed PR; the only thing missing is the pull request record on GitHub.

To enable actual PRs, run these once in your own terminal:

```bash
winget install --id GitHub.cli
gh auth login
```

Claude will not ask you for a token and cannot accept one — authentication has
to happen in your own session. Once `gh auth status` succeeds, the workflow
switches to `gh pr create` / `gh pr merge` with no other changes.

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

All 6 suites, 143 checks, pass together as of the desktop-screens merge.

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
