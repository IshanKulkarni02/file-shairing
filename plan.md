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
| D | Sync | **Done** |
| E | macOS and Linux | **Code done**, unverified on real hardware |
| F | Client mode — connect to other hosts | **Done** |
| G | P2P over the internet | **Done** (relay; hole punching not attempted) |
| H | Metadata and search — the foundation | **Done** |
| I | Search across every machine | **Done** (see note below — one gap left open on purpose) |
| J | A central index every device can reach | **Done** (relay-backed; GitHub not built, see note) |
| K | Import on connect — cameras, drones, cards | **Done** |
| L | Sorting rules, versioned in git | **Done** |
| M | Instructions in plain language | **Done** (grammar/plumbing tested; real-model quality unverified here) |
| N | Content search — the fuzzy cases | **Done** (CPU-verified end to end; GPU and packaged-install unverified here) |
| O | The assistant — tools, graduated trust, trips | O1–O4 **Done** (O4 desktop-only); O5 not started |

Phases A–G made one machine's library good and let machines reach each other.
H–N are a different goal: **one searchable space across every device and
Google Drive, that files find their own way into.** See "The file network"
below.

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
| `test/sync-plan.mjs` | what a sync decides: all nine source/target verdict combinations enumerated, first-run safety, conflict policies, case-only name collisions, and a multi-round simulation proving a deletion stays deleted and a conflict does not loop |
| `test/sync.mjs` | carrying a plan out against real files: mtimes preserved, deletions recoverable from trash, encrypted files copied without ever being opened, links not followed, a drive pulled mid-run resuming cleanly, and a corrupt baseline never reading as deletions |
| `test/sync-routes.mjs` | syncs over HTTP: setting one up, the guards on where it can point, a preview that writes nothing at all, a real run, a change made on the drive coming back, a deletion propagating and staying gone, and a viewer being refused |
| `test/sync-watcher.mjs` | running on connect: an already-connected drive is not an arrival, a replug runs again, an unrelated drive does not, a failure is not retried every tick, and overlapping ticks start one run |

| `test/remote.mjs` | being a client of another host: address forms, certificate pinning, and that a wrong fingerprint stops the password ever being sent |
| `test/discovery.mjs` | finding hosts on the LAN: announce, query-on-start, self-exclusion, expiry, and ignoring junk on the group |
| `test/connections.mjs` | pairing and copying between two libraries, with the password never reaching config.json |
| `test/volume-parsers.mjs` | reading real recorded diskutil and lsblk output, so the macOS and Linux paths are covered from any machine |
| `test/autostart.mjs` | start-on-login per platform, especially the Linux XDG entry Electron does not write |

All 25 suites, 825 checks. Run them with `npm test` — it starts its own
throwaway library and server and cleans up afterwards, so nothing needs
starting by hand and a real library can never be touched.
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

## Phase D — sync (done)

Two-way sync between an album and a folder on a registered drive, running on
demand or when the drive is plugged in. Built in four layers, riskiest first.

**`lib/sync-plan.js` decides; nothing else does.** No filesystem access at
all. This is the one place in the app where a wrong answer destroys photos,
and a pure function is the only part of it that can be tested exhaustively.

**Three states, not two.** Source-versus-target cannot tell "added here" from
"deleted there" — they are the same observation — which is why naive two-way
sync resurrects every file you delete. Each run also compares against the
baseline recorded after the last successful run, so a file is deleted only
when the baseline vouches it was there last time and one side has since
removed it. No baseline means a first run: nothing is deleted, the two sides
are merged.

The baseline is built by re-listing both sides **after** the run, never from
what the plan intended, so it cannot claim a file matched when it did not.
That imposes one requirement on the runner: it must preserve modification
times, or the next run sees the whole library as changed on both sides.

**`lib/sync.js` does it, carefully.** Nothing is hard-deleted — deletions go
to a stamped trash folder on the side being changed. Copies are written
beside the destination and renamed in, so a drive pulled mid-copy leaves the
old file or the new one, never half. Encrypted files are copied as bytes and
never opened, which is the whole reason an encrypted album is safe on a drive
you lose. Links are skipped rather than followed: a relocated album points at
another drive, and following it would copy that drive into the target behind
your back.

**`lib/sync-watcher.js` starts it on connect** by polling volume ids rather
than listening for device events — duller, but identical on all three
platforms, and it survives the app being asleep when the drive went in. Only
absent→present counts as an arrival, and a failure is not retried until the
drive is genuinely replugged.

**Decisions worth not relitigating:**

- **keep-both is the default** because it is the only policy that cannot lose
  work. `newest-wins` is offered with its cost stated where it is chosen: Mac
  and PC clocks disagree often enough to keep the wrong version.
- **Deleted here, edited there → the file comes back.** Keeping it is the
  recoverable mistake.
- **Names differing only in capitalisation are skipped, not guessed at.**
  Linux keeps `Photo.jpg` and `photo.jpg` apart; Windows and macOS do not, so
  syncing between them would have one silently overwrite the other with the
  survivor decided by iteration order. Phase E makes this a live path.
- **A `pull` policy exists separately from `mirror`.** Mirror pushes the
  library onto the target and deletes whatever the target holds that the
  library does not — on a shared Google Drive or Dropbox folder that is
  somewhere between rude and catastrophic. `pull` collects from the other side
  and never writes to it, and never deletes on either side: a file that
  vanished from the cloud is not an instruction to lose the copy you fetched.
- **Previews are the same call as the run**, with `dryRun` set, so what is
  shown cannot drift from what happens. Deletions are listed first — burying
  them under a hundred copies is how someone approves one blind.

**Deleting a relocated album** trashes its contents into a `.lanshare-trash`
folder on the drive that holds them, and only then removes the link. The
ordinary path would trash the link alone, leaving gigabytes on that drive with
nothing pointing at them — not deleted, just invisible and permanent. It
refuses outright when the drive is not connected, because there is no honest
way to delete something you cannot reach. Same principle as trashing a vault
file inside its own vault: a deletion stays with the data it belongs to.

**A bug found by driving the real UI, not by the tests:** a *preview* created
a folder on the drive, because target resolution mkdir'd unconditionally and
the engine's own dry-run test never went through that layer. **Third time an
audit has found a bug in the seam between two well-tested modules** (after
the vault-blind routes in Phase B and the junction listing in Phase C). The
pattern is now reliable enough to plan around: when two modules are each
tested and then joined, test the join specifically.

---

## Phase E — macOS and Linux (code done, unverified on hardware)

**What is honestly true:** the code is written, and the parts testable from a
Windows machine are tested. Nothing here has run on a Mac or a Linux box.
Read the status as "ready to try", not "known working".

**Volume detection was made testable rather than left hopeful.** Command
execution is now separate from parsing, so `parseDarwinInfo`,
`parseDarwinVolumeNames` and `parseLinux` are unit-tested against real
recorded `diskutil` and `lsblk` output. That does not prove those commands
exist or accept these flags — only hardware proves that — but it covers the
part most likely to be wrong, and it immediately earned its keep: the macOS
size regex was written backwards (`diskutil` prints the exact byte count
first and the rounded figure in parentheses) and reported every Mac volume as
0 bytes.

Cases now handled that naive parsing gets wrong: volume names with spaces;
volumes with no UUID (network shares — degrade to the path fallback rather
than crash); disk images reporting only a partition UUID; Thunderbolt disks
that claim to be "Fixed" media; snap's dozens of loop-mounted squashfs
pseudo-drives on Ubuntu; `rm` reported as the string `"1"` by older lsblk;
and one filesystem mounted at several points by btrfs.

**Autostart could not use Electron's API alone.** `setLoginItemSettings()`
covers Windows and macOS and **does nothing at all on Linux** — silently, so
the checkbox would tick, the setting would save, and nothing would ever
start. `lib/autostart.js` writes the XDG
`~/.config/autostart/lanshare.desktop` entry there instead: honours
`XDG_CONFIG_HOME`, quotes paths with spaces, and passes the app directory as
well as the executable when running from source, or the entry would launch a
blank Electron shell. State is read back from the OS rather than from config,
because the entry can be removed outside the app.

**The Linux tray can be absent entirely** — GNOME without the AppIndicator
extension, or a minimal window manager — and Electron throws rather than
degrading. That matters beyond a missing icon: with close-to-tray on, closing
the window would hide it somewhere unreachable. Tray creation is guarded, and
close-to-tray is forced off when there is nowhere to hide to.

**Packaging:** DMG (arm64 + x64), AppImage and `.deb` alongside NSIS. ffmpeg
is bundled only on Windows; macOS and Linux fall back to `PATH` (brew/apt),
and the `.deb` declares `ffmpeg` as a dependency so apt supplies a build that
stays patched. `vendor/ffmpeg-mac` and `vendor/ffmpeg-linux` exist for anyone
wanting a self-contained AppImage. Without ffmpeg the app still runs; what is
lost is video thumbnails, duration and HEVC conversion.

These **do not cross-compile usefully** — a DMG needs macOS, a `.deb` wants
Linux or Docker — so `desktop-build.js` defaults to the host platform and
says so when asked for another. It also calls the local `electron-builder`
binary directly instead of going through `npx`, which this machine's security
software intermittently refuses outright.

**macOS ships unsigned** without an Apple Developer account ($99/yr).
Gatekeeper refuses unsigned apps on first launch; the way in is right-click →
Open, once. Apple policy, not something code can work around. The build now
says so while building rather than leaving it to be discovered.

**Still needs real hardware:** that `diskutil`/`lsblk` are present and take
these flags; that the XDG entry actually launches in a real desktop session;
that the tray works under GNOME and KDE; that sharp and ffmpeg resolve inside
an AppImage's mount; and that the DMG opens at all.

---

## Phase F — client mode (done)

Every machine can now be a client of every other. A Mac browses the Windows
box's library and copies either way, with neither one special.

**Certificate pinning, not `rejectUnauthorized: false`.** Every LANShare host
serves HTTPS with a self-signed certificate; there is no certificate authority
on a home network and never will be. Disabling verification would accept any
certificate from anyone, which is plain HTTP with extra steps — anything on
the network could impersonate the host and collect the password sent to it.
So the certificate is pinned the way SSH pins host keys: the first connection
records its SHA-256 fingerprint, every later one requires exactly that, and a
change fails loudly rather than being waved through. The first connection is
trusted blindly, the same trade-off SSH makes.

**The test for that found a real hole.** Node's global agent pools TLS
sockets, so a socket opened for one host — or for an unpinned probe — was
handed to a request with a different expectation, whose handshake never ran
and whose fingerprint was therefore never checked. A pooled socket skipping
the check is exactly the hole pinning exists to close. Fixed by never using
the global agent, verifying during the handshake so the request is never
written, and re-checking in the response callback as a backstop. The strongest
test asserts the property that matters: signing in to a wrong-fingerprint host
with the *correct* password leaves no session there, proving the password was
never sent rather than merely rejected afterwards.

**Passwords go to the OS keychain**, via Electron `safeStorage`, never to
config.json — which gets copied around with the library, synced to backup
drives, and read by anything running as the user. Where no keychain exists
(headless, or Linux without a keyring) nothing is saved and the password is
asked for each time: worse to use, much better than a plain-text file that
looks harmless. A blob that cannot be decrypted — restored backup, different
user — reads as "not saved" and asks, rather than throwing a keychain error.

**Discovery is UDP multicast, not mDNS.** The plan said mDNS, which is right
if you want to be found by *other* software; nothing here needs that, since
only LANShare looks for LANShare. mDNS means either a dependency carrying a
full DNS-SD stack or several hundred lines of packet construction with
conflict resolution to get subtly wrong. One multicast group does the same job
in a fraction of the code with no dependency. Announcements carry only what a
port scan would reveal anyway — never library contents, account names or keys.

**Two bugs found by running it for real rather than by the tests:**

- `addMembership(group)` with no interface lets the OS choose, and on a
  machine with virtual adapters (Hyper-V, WSL, a VPN) it routinely chooses one
  of those. Nothing errors; discovery just silently never finds anything,
  which is a miserable thing to debug. Now joins every interface explicitly.
- `start()` destructured only three fields out of `createApp()`, so the sync
  watcher and the discovery service never reached the handle the desktop app
  holds. Every caller checks for them before use, so this cost nothing
  visible — the features simply did nothing, silently. **A third pattern to
  watch alongside the seam rule: an optional-chained property that is always
  absent looks exactly like a feature that is off.**

---

## Phase G — over the internet, no port forwarding (done)

Both machines connect **out** to a relay, which is why neither needs anything
opened on its router: routers have always allowed outbound connections.

**The decision this phase was waiting on.** The plan offered hole-punched
WebRTC with a TURN relay as fallback, or Tailscale and no code at all. This
builds the relay and not the punching. Punching lets peers talk directly and
is faster, but it needs a WebRTC stack, fails outright on symmetric NAT, and
*requires a relay as the fallback anyway*. Building the fallback first means
the feature works everywhere today, and direct connections can be added later
without changing the protocol above that line. Tailscale remains a perfectly
good answer for anyone who would rather not run anything at all — that option
has not gone away.

**The relay is as untrusted as it can be.** It pairs two connections naming
the same room, copies bytes, and understands nothing else. Every frame is
sealed with AES-256-GCM under a key derived from the pairing code, which is
exchanged out of band and never reaches the relay. A hostile relay operator
can cut a connection and see that two peers are talking; they cannot read a
password, a photo, a filename, or even which URL was requested. The test
proves that rather than asserting it: it records every byte crossing the relay
and checks the plaintext marker, the password and the request path are all
absent.

**The host replays tunnelled requests against its own server over localhost**
rather than injecting into Express directly, so every route, permission check
and vault rule already applies. A second path into the app would be a second
place for all of that to be got wrong.

**A relayed host wears the same interface as a direct one**, so browsing,
copying and the Machines screen work without knowing which they hold. The test
proves it by running the copy helper, unchanged, over the relay.

**Three bugs found by running it rather than reading it:**

- The relay's `paired` flag was a per-connection local, so only the peer that
  *completed* the pairing ever saw it. The other went on treating real traffic
  as a hello and hung up on the first frame.
- A refused impostor's own disconnect tore down the room it had just been
  refused entry to, because `roomId` was assigned before the occupancy check.
  Anyone who learned a room id could cut a live session off.
- `TunnelHost.start()` awaited the pairing, so a host could not finish
  starting until a client arrived, and no client could arrive until it had.

**Known limits, stated rather than discovered:** traffic goes through the
relay, so throughput is bounded by it and by the slower of the two internet
connections — a LAN transfer is far faster and should be preferred when both
machines are home. The pairing code *is* the key: anyone holding it can reach
that library, which the UI says at the moment of sharing. Turning internet
access off issues a new code and invalidates the old one.

---

## Post-hoc audit of Phases D–G (2026-08-06)

Read critically rather than re-run. Four real bugs, none of which a green
suite would ever have surfaced:

- **A 25 MB video could not cross the tunnel at all**, in either direction —
  the frame ceiling is 16 MB and nothing split larger messages. For a photo
  *and video* library reached from elsewhere, that is the main thing someone
  would want it for. The tunnel test only ever moved 300 KB. Messages are now
  split across frames and reassembled; tests move 9 MB both ways.
- **A first sync to a folder that did not exist yet aborted on its first
  action**, reporting that the drive had been disconnected — about a drive
  that was plugged in throughout. The liveness check watched this sync's own
  folder rather than the drive. Masked in normal use because the
  target-resolution layer creates the folder first, so only a direct caller
  hit it.
- **Every visitor arriving over the relay was recorded as `127.0.0.1`**,
  because tunnelled requests are replayed against the local server over
  loopback. That put remote logins in the same throttle bucket as someone at
  the keyboard — so a remote guesser with a leaked pairing code could lock the
  owner out of their own machine — and showed remote sessions on the Devices
  screen as local, which is exactly the screen you would check if you were
  worried about one. Now marked at the tunnel and trusted only from loopback.
- **Deleting a relocated album trashed only the link**, stranding its real
  contents on the drive (recorded under Phase C above).

Also confirmed sound while looking: an encrypted album syncs with its vault
metadata intact, its files arrive as ciphertext, and the plaintext appears
nowhere on the drive — a copy without that metadata could never be opened, and
nothing would have said so. That is now a test.

**The pattern holds.** Every audit so far has found bugs in the seam between
two individually well-tested things: vault routes and plain routes (B),
junctions and listings (C), the engine and its resolution layer (D), the
frame size and a real file (G). Re-running a green suite has never once found
one of these. The rule earned four times over: **when two tested things are
joined, test the join, with realistic inputs.**

---

## Deep audit (2026-08-06)

Attacking the boundaries rather than exercising the features. What held, and
what did not.

**Held, under direct attack:** a token with an edited payload, a stripped
signature, or a signature from another secret is refused; a viewer cannot
create accounts, change its own role, read the account list, register a drive,
see the syncs, delete, upload or make an album; Windows device names
(`CON`, `LPT1`), alternate data streams (`x.txt:hidden`), trailing dots and
embedded NULs never reach the filesystem; a filename cannot inject a response
header; a file copied from one vault into another does not decrypt there;
swapping two albums' vault metadata does not expose either one's files; a
baseline naming files that never existed deletes nothing; and emptying the
trash does not follow a link planted inside it.

**Did not hold:**

- **A sync could be pointed at a folder inside itself, and grew without
  bound.** Measured: 6 → 9 → 12 files over three runs, filling the disk. Fully
  reachable, because a "drive" could be registered *inside the library* — or
  as the library, or as a folder containing it — and sync-on-connect would
  then do it repeatedly and unattended. Locations now refuse those three
  shapes, and the engine independently refuses any pair where one folder is
  inside the other, so a caller that has not learned the rule cannot
  reintroduce it.
- **A refused filename returned 500.** `CON.jpg`, a trailing dot, a name with
  a separator — all correctly refused, all reported as a server fault. Clients
  retry 5xx, so a folder containing one such file would be uploaded and
  refused forever. Now 400, since it is the request that is wrong.

Both join the running tally of bugs living where two tested things meet, or
where a realistic input meets code written around a tidy one.

---

## Third audit: exhaustion and a hostile peer (2026-08-06)

The relay's far end is authenticated by the pairing code — but a code can
leak, so the question is what someone holding one can do beyond reading the
library they were given.

**Held:** a peer streaming parts of a message that never completes does not
grow memory without limit (heap 16 MB → 30 MB while pushing 80 MB) and the
host keeps serving; a frame that fails authentication drops the connection
rather than spinning; the relay caps rooms at 500 and stayed at exactly that
after 520 attempts; a zip request naming 5,000 missing paths is handled; 300
sign-ins in a row leave the server healthy; an absurdly deep path is refused
rather than recursing.

**Stated rather than fixed:** message reassembly is capped at 512 MB. That
bounds memory but is generous, and it is the same headroom that lets a large
video transfer at all. Someone with a leaked pairing code could make the far
end allocate toward that ceiling. Lowering it would break large transfers;
streaming instead of buffering whole files would fix both, and is a larger
change than it looks.

**Packaged build verified** at the same time, because Phases F and G had never
run inside one — and the asar shim has already caused one bug (`fs.rmSync` on
junctions). In the packaged app: all eight screens render, the OS keychain
works, discovery runs, the tunnel reports status, and over its real HTTP API a
vault is created, an encrypted upload decrypts back byte for byte, sharp
renders a thumbnail and zip works — all from inside `app.asar`.

---

## First-run setup (done)

A fresh install used to generate a random admin password and print it once, on
a screen someone could close before reading it. There is now a wizard that
covers the app until it is finished: choose a username and a password of at
least 8 characters, pick where the library lives, add the Windows firewall
rule, and choose whether to start with Windows.

**The firewall step is the one that earns its place.** Windows silently drops
incoming connections; nothing errors, the phone just times out. It is the
single most common reason a running LANShare cannot be seen from a phone. The
rule is scoped to private networks only — never public — and is added by a
button the user presses, so the UAC prompt is their own action rather than
something appearing unbidden.

The wizard replaces the generated account rather than adding beside it, so
there is never a second admin with a password nobody knows, and revokes the
sessions belonging to it.

**Three executables were called some variant of LANShare.exe** — the
installer, the unpacked app, and the portable console build — and only one
installed anything. Running the wrong one launches the app and installs
nothing, which reads exactly like a broken installer, and did. Now:
`LANShare-Installer-<version>.exe`, `LANShare-Portable-NoInstall.exe`, and a
build that prints which file to run.

Two bugs found while building it, both the familiar seam:

- `configLib.setUser` loads config from disk, changes that copy and saves it,
  while the desktop process holds its own in-memory config. Calling both meant
  the later save wrote back a stale object and **wiped the account that had
  just been created**.
- `desktop/main.js` overrode `LANSHARE_HOME` unconditionally, so a test
  pointed at a throwaway directory silently ran against the real install and
  rewrote its account. An explicitly set value now wins.

**The wizard shipped unusable, and only a person could have found it.** The
card was 873px tall in a 683px window, so "Finish setup" sat 158px below the
fold with nothing indicating there was more to scroll to. Every automated
check passed, because they all clicked the button through the DOM — which
works perfectly on a button nobody can see. The cause was `max-height: 100%`
on a card inside a content-sized grid row, where 100% resolves against the
content and constrains nothing. Now a flex column capped at
`calc(100vh - 2.5rem)`, with the steps scrolling and the action pinned below
them; measured with the viewport overridden at 380x500, 420x560, 466x683 and
900x1000, the button and the first field are on screen at every one.

**The lesson, and it is not a small one:** driving a UI through the DOM proves
the wiring, never the layout. `element.click()` does not care whether the
element is visible, reachable, or covered. Anything that is meant to be *seen*
needs its geometry asserted — is it inside the viewport — or a person needs to
look at it.

Verified in the **installed** build, not just a dev run: the wizard appears on
a fresh profile, all four steps render, completing it leaves exactly one admin
account, the server starts, and the chosen password signs in over the real LAN
address while a wrong one is refused.

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

---

# The file network — phases H to N

## What changes

A–G built a photo library that several machines can reach. H–N build something
different: **one searchable space across every device and Google Drive, that
files find their own way into.**

Three things do not exist yet, and everything else waits on them:

1. **Nothing is indexed.** There is no search route at all. You can browse, and
   that is it.
2. **Nothing reads metadata.** No EXIF, so "photos from that ride" and "drone
   shots" are unanswerable — because the answer is sitting inside the file and
   nobody looks.
3. **Nothing knows what other machines hold.** You can browse another host, but
   not ask "who has this?"

What *is* already built and carries straight over: reaching any machine
(discovery, pinned certificates, the relay), copying either direction, pulling
from a cloud folder, volume identity, and doing something when a drive appears.

Storage is also already file-type agnostic — `kindOf()` returns `'file'` for
anything it does not recognise, and upload and download never cared. **"All
files, not just photos" is a gallery and search problem, not an architecture
one.**

---

## H — Metadata and search

The foundation. Nothing above works without it, and it is useful on its own the
day it lands.

A SQLite index per host holding, for every file: path, size, mtime, content
hash, and extracted metadata — EXIF camera make and model, capture time, GPS,
dimensions, duration. A scan compares size and mtime against what is already
indexed and only re-reads what changed, so a repeat scan of a mostly-unchanged
library costs almost nothing — run at startup and on demand, not via a live
filesystem watcher.

**Built:** `lib/metadata.js` (a dependency-free EXIF/TIFF parser — no library
was trusted with untrusted camera input), `lib/index-db.js` (the SQLite index,
FTS5 text search, structured and GPS-radius filters), `lib/indexer.js` (the
incremental, vault-aware scan), and `GET /api/search` — every result filtered
through `permissions.isWithinRoots()` and live vault-lock state before it
leaves the server, the same boundary this project has gotten wrong before.
A search box in the web gallery reuses the existing tile/viewer UI for
results, routes anything encrypted or non-previewable to its actual album
instead of a broken frame, and never touches `state.path` — clearing a search
just returns to wherever browsing was left off.

**Why EXIF is the whole game.** "Drone shots go in the drone folder" is not a
judgement call — a DJI stamps its model into every file. So does your camera,
your phone, your GoPro. Date, coordinates, resolution, lens. A rule reading
that field is exact, instant, testable and self-explaining; a model guessing
from pixels is none of those, and this app moves files. **Metadata does the
work. AI is for what metadata cannot answer.**

GPS is what makes "that place I rode to" resolvable at all: geocode the place
name once, then match coordinates within a radius.

Also lands here: **content hashing**, which pays for itself three times over —
duplicate detection, knowing a file on two machines is the same file, and
knowing an SD card has already been imported.

Encrypted albums are indexed by what is knowable without the key — path, size,
time — and nothing else. A vault that gave up its EXIF to the index would not
be a vault.

## I — Search across every machine

Each host publishes its index; peers fetch, cache and merge it. A search asks
everyone reachable, merges by content hash so the same file on three machines
is one result showing three locations, and answers from cache for machines
that are off — labelled as such. **"Last seen on the laptop three days ago" is
a useful answer; pretending it is live is not.**

One click fetches a result from wherever it lives, over the transport already
built — LAN if it is there, relay if it is not.

**Replica awareness matters more than it sounds.** Once the index knows a file
exists in three places, it can warn before you delete the last copy. A single
view of everything makes deleting the only remaining copy much easier to do by
accident.

**Built:** `lib/federation.js` — a search asks every connection in
`config.connections` (the same list the desktop Connections screen already
manages; nothing new is paired) for its own `/api/search`, in parallel, each
bounded by its own short timeout so one slow or dead machine never holds up
the rest. Results merge with the local ones by content hash into one entry
per file naming every machine that holds it — `{source, label, path,
reachable, cachedAt}` per location, `primary` marking which one the result's
top-level fields actually describe. `GET /api/search` carries this for every
account, but **only ever contacts another machine for a local admin**: a
connection's password is a credential for whatever account it was paired as
on the *other* machine, sometimes a broader identity than the local account
asking — letting a restricted local viewer transitively exercise a stored
admin-elsewhere password would be exactly the kind of boundary this project
has gotten wrong before. A non-admin's search still runs, just local-only,
silently rather than refused. Proven against two real LANShare servers in
`test/federation-routes.mjs`, including killing one mid-test.

**Caching, scoped honestly.** A file is remembered in a small per-peer SQLite
cache (`.lanshare/peers/<id>.db`, `lib/index-db.js`'s schema, unchanged) the
moment it comes back from a *live* query — not by periodically mirroring a
peer's whole index, which nothing here ever asks for. A file that peer holds
but that was never part of a search result while both machines were online
will not appear from cache. This trades completeness for honesty: what is
cached was really seen, not synthesised, and the web gallery always shows
when.

**Two gaps left open on purpose, not by oversight:**
- **No fetch-through-the-web-gallery yet.** A remote-only result shows where
  it lives and whether that machine is reachable right now, but clicking it
  cannot pull the bytes through this server — that is a proxy-download route
  this phase did not build. Today, actually getting the file still means the
  desktop app's existing Connections screen. Worth adding, but it is its own
  piece of surface (streaming a remote file back through this server,
  including range requests for video), not a small addition to search.
- **No delete-time "this is the last copy" warning.** The data for it now
  exists — every search result already carries `locations` — but nothing
  reads it at the moment `/api/delete` runs. Wiring that in is comparatively
  small and is the natural next slice of this idea, just not one this phase
  claims to have shipped.

## J — A central index every device can reach

The requirement is "somewhere central, always up, reachable from any device,
nothing to maintain". Two ways to meet it, same index format either way.

**GitHub, encrypted.** A private repo holding an index blob sealed with
AES-256-GCM under a key derived from a passphrase the devices share and GitHub
never sees. Free, always up, zero maintenance, reachable anywhere. If the
account leaked, someone gets ciphertext.

Plaintext filenames must never go there. An index is more revealing than the
files it describes: `passport-scan.pdf`, `medical-results-march.pdf`,
`resignation-letter.docx`, plus sizes, dates, and which machine holds what.

**The cost, stated so it is not discovered later:** encrypted data does not
delta-compress, so every update stores a fresh full copy in git history for
ever. Mitigated by committing on meaningful change rather than continuously,
one index file per device so churn is isolated, and squashing history on a
schedule. It needs doing deliberately.

**The relay, alternatively.** It is already a central always-on point, already
holds nothing readable, and has no history to bloat. If one is being run for
internet access anyway, this is strictly better. Not either/or — same format,
different shelf.

**Built: the relay, not GitHub — chosen, not defaulted to.** GitHub needs a
private repo and a personal access token created and handed over before a
single line of the integration could even be tested; the relay needs neither
— it is infrastructure this project already runs (Phase G), and building
against it meant every piece of this phase could be built *and proven* end to
end without waiting on anyone. The trade is real and worth stating: the
GitHub route has no server for you to run, while the relay one does. If a
relay is already up for internet access anyway, this costs nothing extra;
starting one solely for this is the actual price of the choice.

The format was kept deliberately transport-agnostic (`lib/central-index.js`
knows nothing about relays) specifically so GitHub remains addable later as a
second backend without redoing the crypto or the blob shape — same index,
different shelf, exactly as sketched above.

`relay/server.js` gained a second, unrelated capability alongside its pairing
pipe: PUT/GET on an opaque encrypted blob, keyed by an opaque string, capped
in size and count, persisted to a handful of small files. This is the one
deliberate exception to "no state on disk" anywhere in this relay — narrow
and documented in the file itself, not a quiet contradiction. **Anyone
already running a relay for Phase G needs to redeploy it for this to work**
— the protocol addition does nothing until the running process is updated.

Two keys come from one shared passphrase (`lib/central-index.js`), typed into
every device the same way a vault passphrase is: an encryption key for the
blob (AES-256-GCM, `lib/crypto/vault.js`'s wrap/unwrap, unchanged) and a
separate lookup key that HMACs into where each device publishes. Both use a
fixed, public, purpose-specific salt rather than a random one — deliberately,
since a random salt needs somewhere to be stored, and the entire problem this
phase solves is several devices agreeing on where to look with no shared
state beyond the passphrase itself typed into each of them.

Each device publishes its whole local index to its **own** storage slot
(`deviceSlotKey`), not into one blob every device edits — exactly the "one
index file per device so churn is isolated" mitigation sketched above,
which also means two devices publishing around the same time never race each
other's writes. A small shared "roster" blob lists which device slots
currently exist, refreshed on every publish; losing that specific race only
leaves a roster entry briefly stale until its owner's next publish, never
loses index data. `GET /api/search` folds this in for a local admin exactly
as it already does live peers (Phase I) — merged by content hash into the
same `locations[]`, always labelled `reachable: false` with when that device
last published, since a central-index entry is a record of what a device
said once, never a live connection. Proven end to end in
`test/central-index-routes.mjs` by publishing from two servers, killing both
completely, and confirming a third — sharing nothing with either but the
passphrase — still finds both of their files. That is the property Phase I's
live federation cannot offer on its own: a dead peer contributes nothing
until it answers a search itself again, but a device that published once
needs never be reachable again for its files to keep surfacing.

**Known costs of this v1, stated rather than discovered later:** the central
index is fetched fresh on every admin search (a roster read plus one read per
device, in parallel, each on its own short timeout) rather than cached the
way Phase I caches a peer's live results — a real, accepted latency cost
under a relay that is slow or far away, not a correctness problem, and the
same caching approach Phase I already uses could be added here later without
changing the format. Text matching against a central-index entry is a plain
substring check, not FTS5's tokenized prefix match the local index gets —
simpler, and correct for the common case, not identical.

## K — Import on connect

A camera, drone, phone or SD card appears. Recognise it as a capture device — a
`DCIM` folder is the near-universal signal — and offer:

> **Import 240 files from DJI Mini 4 Pro?** Starting in 30s… [Import now]
> [Cancel] [Never for this card]

Then copy, verify, and sort by the rules from L. **It never deletes from the
card**, on any path, ever. Formatting the card is the owner's decision, made
after they can see the files arrived.

What has already been imported is remembered by content hash, so re-inserting
the same card picks up only what is new. Free space is checked before starting
rather than failing at 80%.

**Built:** `lib/import.js` does the mechanics — plan (read-only: hash
everything on the card, ask the library's own index whether it already has
each hash — exactly what Phase H's duplicate detection was for) and run
(copy beside the real name, re-hash the copy, only then rename it into
place; a mismatch is failed loudly, not backed up silently wrong). Free
space is checked once against the plan's total before the first byte is
written. Nothing here ever opens a source file for writing, renames
anything on the card, or deletes from it — there is no code path that
could, not just a rule that says not to. `lib/capture-device.js` is the
policy in front of it: a volume is only ever offered if it is not already
this install's own library or a relocated album's drive, and "never for
this card" is remembered by the same stable volume id Phase C already uses,
so it survives a replug. `lib/capture-watcher.js` polls for arrivals the
same way `lib/sync-watcher.js` already does for a configured sync target,
just applied to *any* unrecognised volume instead of only a configured one.

The prompt itself reuses the desktop app's existing single-window
architecture rather than a second `BrowserWindow` — Electron's
`dialog.showMessageBox` cannot auto-trigger after a countdown, so the
existing "cover" pattern the first-run wizard already uses (a full-window
overlay, shown and hidden with the same `hidden` toggle) carries this too.
Detected while the window is hidden in the tray, the window is brought to
front — the same `showWindow()` the tray's own "Open" already calls — so
the prompt is never silently waiting behind a hidden window.

**Where imports land, until L exists to decide better:** a predictable
`/Imports/<device label>` album, created if needed. That is a deliberate
placeholder, not a guess at what L's rules will look like — the destination
is resolved in exactly one place (`importDestination()` in
`desktop/main.js`), which is the seam L replaces, not a scheme threaded
through the rest of this phase.

**A real limitation, stated rather than glossed over:** the device "label"
in "Import 240 files from DJI Mini 4 Pro" is aspirational — there is no
reliable, cross-manufacturer way to ask a mounted volume for a real
make/model string, so what is actually shown is the volume's own label
(often a generic "NO NAME" or whatever the camera's firmware happened to
set, occasionally something legible like "DJI_MINI4"). Honest given what a
FAT32 volume actually exposes, not what the mockup implies.

## L — Sorting rules, versioned in git

Rules are small, human-meaningful, change rarely, contain nothing private, and
benefit enormously from history — *why has everything gone to /Drone since
Tuesday?* → `git log`. **That is what git is genuinely good for here.** The file
index is the opposite on all four counts.

A rule is a filter and a destination:

```
when camera.make = "DJI"                 → /Drone/{year}/{month}
when kind = video and gps near "Manali"  → /Rides/Manali
```

Ordered, first match wins, with a dry run showing exactly which files would go
where before anything moves. **Every rule-driven move is undoable as one
batch** — automated sorting will be wrong sometimes, and the difference between
a good feature and a frightening one is whether it can be taken back.

**Built:** `lib/sort-rules.js` is a small hand-written parser for exactly the
format sketched above — one rule per line, `#` comments, ANDed clauses
optionally ORed together (disjunctive normal form; no parentheses, because
nothing this format needs to express requires them, and a fully general
boolean grammar is a lot of surface for something meant to stay readable by
someone who is not a programmer). Saving a rule set parses it first, so a
broken rule is refused before it ever reaches disk, and — when `git` is on
the machine's PATH — commits it to a small dedicated repo under
`.lanshare/rules`, local `user.name`/`user.email` only, never touching
anyone's real git identity. No git installed is not an error: the rules
still save, just without history, the same "optional tool, graceful
degradation" treatment ffmpeg already gets elsewhere in this app.

`lib/geocode.js` resolves a `gps near "Place"` clause's place name through
OpenStreetMap's Nominatim — free, keyless, chosen for the same reason the
relay won over GitHub in Phase J: usable without anyone first setting up an
account. Rate-limited to Nominatim's own policy (one request per second) and
cached to disk indefinitely once resolved — but a *failed* lookup is
deliberately **not** cached, since caching a miss forever has no way to
self-correct if the failure was only ever the network having a bad moment,
while retrying costs nothing extra beyond the one request, since geocoding
only ever runs when a person is actively working with rules, never on a
background loop.

`lib/sort-engine.js` is the three verbs: `plan()` (read-only — a file
already exactly where its own matching rule would put it is left out
entirely, which is also what makes applying the same rules twice a no-op the
second time), `apply()` (same-volume rename, or a verified copy-then-delete
for a relocated album on another drive — the original is only ever removed
after the copy is re-hashed and found to match), and `undoLastBatch()`
(moves everything in the most recent batch back; a partially-blocked undo —
something new now sits where a file used to be — leaves only the
still-stuck files in the batch record rather than losing track of what is
and is not back in place, so calling undo again only retries those).

Reachable two ways: `/api/sort-rules*` (admin-only, `lib/server-app.js`) for
the web gallery or anything else over HTTP, and a `rules:*` IPC namespace in
the desktop app that calls the same `lib/` modules directly — mirroring
exactly how `sync:*` already works, rather than looping the desktop app
back through its own HTTP server. A new "Sorting rules" screen in the
desktop app (plain textarea, preview, apply, undo, and — when git is
available — a visible history list) is the one place both paths converge.

Phase K's import now consults these rules too: after a card's files are
copied to `/Imports/<device>` and indexed (metadata a rule might need — EXIF
camera fields, GPS — only exists once that scan has actually read the new
files), a sort plan scoped to *exactly those files* runs automatically, and
anything a rule claims moves on from the import folder immediately.
`/Imports/<device>` is where whatever no rule claims stays, not a queue
waiting to be manually re-filed.

## M — Instructions in plain language

The settings UI you talk to. Not an agent with file access — a translator that
turns a sentence into a filter you can see.

> *"I was on a motorcycle ride today at Manali, move all pics and videos to
> /Rides/Manali and store it in Google Drive"*

becomes

```
date = 2026-08-11
gps within 2 km of Manali (32.24, 77.19)
kind in (image, video)
→ move to /Rides/Manali, then push to Google Drive
```

and then: **"47 files match — here they are. Proceed?"**

The model drafts, the tested code executes, and a person approves in between. A
wrong draft is visible and costs a click, which is why a small local model is
sufficient — and why it is never trusted with a file operation.

Standing instructions ("keep all drone shots here") are saved as rules; one-off
ones run once.

A local 7–8B model fits the RTX 3060's 6 GB VRAM at 4-bit. Ample for drafting a
filter, inadequate for being trusted with deletions — which is exactly the
split this design already makes.

**Built:** `lib/nl-rules.js` talks to a local Ollama-compatible HTTP API
(`127.0.0.1:11434` by default, no account or bill attached — the same
"no new external credential" reasoning that picked the relay over GitHub in
Phase J and Nominatim over a paid geocoder in Phase L) and asks it to produce
exactly one line in **Phase L's own rule grammar**, nothing more exotic. The
safety property is mechanical, not a prompt instruction: every draft, however
the model phrases it, is run through the identical `sortRules.parse()` a
hand-typed rule goes through before it is ever shown, previewed, or actioned.
A draft that fails to parse — an invalid field, a hallucinated syntax — comes
back as an ordinary `{text, parsed: null, error}`, displayed and hand-editable
exactly like a person's own typo, never thrown or silently retried. Only a
genuine failure to reach the model at all (not running, bad HTTP, empty
response) is a hard error.

The grammar has no parentheses (Phase L's own choice, for the same
readability reason), so an instruction like *"move all pics and videos"*
cannot be expressed as `kind in (image, video)` the way the vision sketch
above shows it — it has to expand to two full OR'd branches
(`kind = image or kind = video`, ANDed with whatever else the instruction
needs on both sides). The few-shot prompt in `GRAMMAR_PROMPT` demonstrates
this expansion explicitly with the Manali example, rather than leaving the
model to guess at a shorthand the grammar doesn't actually support.

Two divergences from the sketch above, both deliberate: the resolved GPS
coordinates are never shown to the user (the rule keeps the place name —
`gps near "Manali"` — and Phase L's geocoder resolves it same as a hand-typed
rule would; showing raw coordinates would just be noise nobody asked for),
and *"store it in Google Drive"* is **not** wired to auto-configure anything.
Sorting rules only ever move files inside the library; reaching into Phase D's
sync-target config on the strength of one one-shot sentence is a different
kind of action than drafting a filter, and this stays on the safe side of that
line. Instead, `cloudHint()` is a cheap local regex — no model call — that
adds an informational note pointing at the existing Sync screen whenever an
instruction mentions cloud storage or backup, alongside the real draft, not
instead of one.

Reachable the same two ways as Phase L: `POST /api/sort-rules/draft` and
`/run-once` (admin-only, `lib/server-app.js`) for HTTP, and `rules:draft` /
`rules:runOnce` IPC handlers in the desktop app calling `lib/nl-rules.js` and
`lib/sort-engine.js` directly. `run-once` takes rule text straight (no model
involved) and applies it immediately without ever touching the saved rules
file — for a draft that is right the first time and does not need to become
a standing rule. The desktop "Sorting rules" screen gained a "Describe it
instead" card above the existing rule editor: an instruction box, the drafted
line shown editable with its live preview, and "Add to my rules" (appends to
the textarea below, still requires the existing Save button) or "Run once".
Both actions re-validate server-side regardless of what the original draft
reported, so hand-editing the drafted line before either is always safe.

**What is not, and cannot be, proven from this environment:** whether a real
local model's translations are actually *good*. Every test here (22 in
`test/nl-rules.mjs`, more in `test/sort-rules-routes.mjs`) runs against a
fake model with an injected response, which proves the plumbing and — above
all — the validation boundary, but nothing in this environment can judge
translation quality, and `test/sort-rules-routes.mjs` proves the honest
fallback for exactly this environment: with nothing listening on
`127.0.0.1:11434`, drafting fails cleanly with a 400 rather than hanging or
crashing, the same boundary Phase L draws around a Nominatim lookup with no
network. Trying it against a real Ollama install is unverified and stated
here plainly rather than implied by green tests.

## N — Content search

For what metadata cannot answer: "photos of whiteboards", "the one with the red
bike". CLIP embeddings computed locally, roughly 1–2 GB of model, comfortable on
this GPU. Optional, and last, because metadata answers most questions first and
answers them exactly.

**Built:** `lib/clip.js` runs CLIP (`Xenova/clip-vit-base-patch32`) entirely
in-process via `@huggingface/transformers` (formerly Xenova/transformers.js),
which executes the real ONNX graph through `onnxruntime-node` — no Python, no
separate server to keep running, no account. That is the same fit-the-stack
reasoning `lib/index-db.js` already used to pick Node's built-in `node:sqlite`
over `better-sqlite3`, and that ffmpeg already gets as a vendored binary
rather than an npm wrapper: one more native dependency alongside sharp (the
one this app already carries), not a new category of one. Confirmed by an
actual spike before any of this was built, not assumed: the model downloads
from Hugging Face and runs real inference in this environment, correctly
discriminating a solid red image from a solid blue one against "a photo of
the color red" / "...blue" text queries. The real, measured footprint is the
~9 MB package plus a ~580 MB one-time model download (the vision and text
towers only) — smaller than the naive first measurement of 1.15 GB, which
turned out to include a redundant, unused merged-graph export pulled in by
an early, wrong API call (the generic `pipeline()` wrapper) rather than the
two specific tower classes `lib/clip.js` actually calls
(`CLIPTextModelWithProjection` / `CLIPVisionModelWithProjection`). An `fp16`
dtype override was tried first to halve that download further and rejected:
it makes `onnxruntime-node`'s CPU execution provider throw during graph
initialization on this model's text tower (a layer-norm fusion pass reaching
for a constant quantization had already folded away) — a real failure caught
by testing against the real model, not a hypothetical. The model cache lives
under `lib/config.js`'s `serverStateDir()` (`.lanshare-server/model-cache`),
never inside `node_modules`, for the same reason config and sessions already
live there: that path is read-only and versioned away on every upgrade once
this app is packaged.

`lib/index-db.js` gained a `content_embeddings` table keyed by
**(content hash, model)**, not path — the same "one entry per hash" identity
`lib/federation.js`'s merge-by-hash and `lib/import.js`'s dedup already use,
so two copies of one photo in different albums are embedded, and pay CLIP's
per-image cost, exactly once. Ranking is a brute-force dot product over every
stored (pre-normalized) vector for the query's model — no approximate-
nearest-neighbour index — because a personal library is thousands of photos,
not millions, and a linear scan at that size is comfortably sub-second
without a second index to keep consistent or another native dependency to
carry. `lib/content-index.js` is the background builder: it reuses
`lib/thumbs.js`'s existing grid thumbnail (already a decoded, uniform 480×480
image for both photos and videos — a poster frame for the latter, via
ffmpeg) as CLIP's input rather than re-implementing decoding a second time,
and never touches vault content, for the identical reason
`lib/indexer.js` never opens it for metadata: `hashesNeedingEmbedding()`
excludes encrypted rows at the query itself, so this module never has to
know a vault is even involved. A real, deliberately-caught bug here: the
first version looped forever on a permanently-failing file, because nothing
ever left it in `hashesNeedingEmbedding()`'s result set once it had failed;
fixed by tracking attempted hashes for the life of one call, so a bad file
is tried exactly once per build, not retried in an infinite loop — a later,
separate build attempt still retries it fresh, same "a cached failure cannot
self-correct" reasoning `lib/geocode.js` already applies to its own lookups.

Reachable via `GET /api/search/content` — open to any role and root-scoped
exactly like `GET /api/search` (the two now share one `visibleRow()` helper
rather than two copies of the same security-relevant filter that could
drift) — and two admin-only routes, `POST /api/content-index/build` and
`GET /api/content-index/status`, mirroring `/api/index/rebuild` and
`/api/index/status`'s own split between "an ordinary search anyone can run"
and "an administrative action that reindexes." There is no separate
enabled/disabled setting: the presence of at least one embedding *is* the
opt-in, exposed to every role via a `contentSearchAvailable` flag on
`/api/me`, so a viewer's gallery can decide whether to offer content search
at all without an admin-gated round trip first. Building the index is never
triggered automatically — not at startup, not after an upload, not after a
sort — unlike the metadata scan; it is a genuinely optional, admin-clicked
action in the web gallery (a "Content search" toolbar button, next to
Central index, following the same one-time-setup convention), because the
first click pays a real, one-time cost (the model download) nobody should
absorb without asking for it.

The web gallery gained a search-mode toggle (a sparkle icon inside the
search box, hidden entirely until `contentSearchAvailable`) that switches
`GET /api/search` for `GET /api/search/content` and relabels the empty/
heading text accordingly. **A real bug only surfaced by testing this in an
actual browser, not by any route test:** content-search results carry the
one order that means anything for them — ranked by similarity — and the
gallery's ordinary newest/oldest/name/largest picker was silently
re-sorting them by upload time regardless, so a "red car" query could put
its best match last for no reason a person could see. Route-level tests
never touch client-side sorting and would never have caught this; it took
actually uploading two real photos, running a real build, and reading the
rendered grid to notice the ranking had been thrown away. Fixed by skipping
the sort picker specifically in content-search mode (and hiding the now-
meaningless picker itself, rather than leaving a control that quietly does
nothing).

**Testing split three ways, matching what each layer actually owns:**
`test/clip.mjs` runs against the *real* model — unlike Phase M's Ollama
dependency, CLIP needs no external server this app doesn't itself run, only
a one-time download this environment was confirmed able to make, so there is
no honest reason to fake it here. `test/index-db.mjs`'s embedding tests use
hand-built synthetic vectors, proving the storage and ranking SQL without
paying a model's load cost on every run. `test/content-index.mjs` injects a
fake `embedImageFile`, proving the orchestration (what gets embedded, that a
second run is a no-op, that one bad file cannot wedge the batch) independent
of whether CLIP itself is any good. Route coverage is split the same way:
`test/search-routes.mjs` covers gating and shape without a model,
`test/content-search-routes.mjs` (registered `slow: true`) pays the real
cost for one genuine end-to-end proof — a real build, a real ranked result,
real root-scoping, a vault photo that never appears.

**What is not, and cannot be, verified from this environment:** GPU
acceleration. Every real run here used `onnxruntime-node`'s CPU execution
provider; the plan's "comfortable on this GPU" is unverified the same way
Phase M's RTX 3060 reference already was, and CPU inference is what a
person without that GPU would actually get, so it is the path this was
built and tested against, not an afterthought. Also unverified: a full
`electron-builder` packaged install with these new native dependencies —
`package.json`'s `asarUnpack` gained entries for `@huggingface/**`,
`onnxruntime-node`, `onnxruntime-common` and `onnxruntime-web`, following
the exact glob pattern already proven for sharp's own entry, but a real
installer was not rebuilt and exercised in this environment. Separately,
`sharp` was bumped 0.33.5 → 0.34.5 (a peer requirement of
`@huggingface/transformers`) and verified in isolation, on its own commit,
before any Phase N code landed on top of it — the full suite passed
unchanged, including `media.mjs`.

---

# Phase O — The assistant

Not started. This is the phase that turns LANShare from a tool you drive into
one you talk to: it should **do, recommend and arrange**, learn your habits,
and ask when it does not understand rather than guessing.

## The honest framing

"As good as a human" is not reachable from an 8B model on a 6 GB card, and
pretending otherwise would set this up to disappoint. But that matters far
less than it sounds, because **most of the intelligence should not come from
the model at all.**

"Group these into trips" is a clustering problem. Deterministic code does it
better than any language model, is instant, is testable, and cannot
hallucinate a trip that never happened. The model's only real job is
understanding what you *meant* and choosing what to run. Getting that split
right is worth more than any amount of model size — and it is the same
principle every AI-touching phase here has already followed: **the model
drafts, a person approves, tested code executes.**

Phase M proved the cost of getting the split wrong from the other side: the
drafter answered "organise by trip, then day, then camera" with
`/Rides/{year}/{month}/Videos` — not because the model was weak, but because
the rule language could not express "camera" at all. A better model would
have failed identically. Widening what the system can *say* beat any amount
of model quality, and probably will again.

## What "learning" will and will not mean

No weights are trained. Nothing is fine-tuned. What is built instead:

- **Accepted-rule memory.** Every rule accepted, and every draft edited
  before accepting, is stored with the instruction that produced it. Later
  prompts carry the closest few as examples. This adapts to one person's
  vocabulary within days ("ride" meaning what *you* mean by it) at a
  fraction of fine-tuning's cost, and it degrades gracefully — a bad example
  is deletable, where a bad fine-tune is a retrain.
- **Correction memory.** A draft you rewrite is a stronger signal than one
  you accept; both are kept, the correction weighted higher, and a recent
  correction is pulled into the next few prompts regardless of topic — the
  fastest way to stop a wrong pattern repeating.

  Stored and injected as **the corrected pair** — your instruction, and the
  rule you actually wanted — never as "the model said X and X was wrong".
  Showing a model its own bad output tends to anchor it toward that output;
  showing the right answer for that instruction carries the same information
  without the pull.

Stated plainly so nobody later reads "learns" as more than it is: this is
retrieval-augmented prompting over your own history. It genuinely improves
output. It is not the model getting smarter.

## Model: local by default, cloud on demand

**Hermes 3 8B** (`hermes3:8b`, ~4.7 GB at Q4) is the local default rather
than a generic instruct model, because this phase is function calling, not
prose — Hermes is Nous Research's Llama-3.1 fine-tune trained specifically
for tool use and structured output. Verified available on Ollama and within
the 6144 MiB this machine has.

A cloud backend sits behind a deliberate, per-request "think harder" action
rather than being the default. That keeps the project's standing
no-external-credential promise true for everyday use, while admitting the
honest truth that hard instructions want a stronger model. Both backends
implement one interface, so neither is load-bearing for the other.

**What leaves the machine on a cloud call must be stated in the UI at the
moment of the call** — file names, camera fields and paths, never file
contents. Anything less is a privacy surprise.

## Structured output, not text the parser has to rescue

Ollama supports grammar-constrained decoding — a JSON Schema in `format`
constrains generation at the token level, so the model *cannot* emit
malformed output. Verified working on this machine (Ollama 0.32.13,
`llama2:latest` returned schema-conformant JSON on the first try).

This is used two ways:

- **Tool calls** are JSON, so the schema is the tool's own signature. A
  malformed tool call stops being a case to handle.
- **Rules stop being generated as text at all.** The model emits a
  constrained object — field, operator, value, destination — and the DSL
  line is *generated deterministically from that*. Phase M asks the model to
  write `when camera.make = "DJI" -> /X` and then parses it back; making the
  structure the interface removes DSL syntax hallucination as a category
  rather than catching it after the fact.

`sortRules.parse()` stays exactly where it is, validating everything before
it acts. It should simply stop ever firing on model output. Belt and braces:
the schema prevents the error, the parser proves it was prevented.

Worth recording since it was got wrong once: Ollama answering **404** means
the model is not installed, and **an error body** carries the real reason
when a model will not load. Both are far more useful than the status code,
and both were being discarded.

## Machine guesses are never stored as facts

A vision model at import time (Moondream2, ~1.8 GB — fits the 6 GB card;
`llama3.2-vision` does not and will not load here) can tag footage with a
handful of words — "tent", "campfire", "motorcycle" — written into the
SQLite index. FTS5 then answers most content questions instantly, leaving
CLIP's vector maths for genuinely visual queries. It also buys something
CLIP cannot: **explainability.** "Why did this match?" has an answer when a
tag matched, and does not when a dot product was merely large.

The hard constraint: **a tag is a guess and must never be stored where a
fact lives.** Everything in the index so far is exact — `camera.make` is
what the camera itself wrote. Tags are a model's opinion. They go in their
own column, are addressed by their own rule syntax, and are shown
differently in previews. If "sort by camera" and "sort by what it looks
like" become indistinguishable, then the first time a guess misfiles
something, confidence in the exact data goes with it — and the exact data
is the reason this app can be trusted with a library at all.

## The tool layer is the actual design

The assistant is a **tool-calling loop**, not a chatbot that emits prose.
The model chooses a tool and fills its arguments; every tool is ordinary
tested code. Splitting them by blast radius is what makes graduated trust
possible at all:

| Read-only — always safe to run | Writes — trust-gated |
|---|---|
| `search_library` | `save_rule` |
| `describe_library` (counts, cameras, date span, what is unsorted) | `apply_rules` |
| `detect_trips` | `run_once` |
| `preview_rule` (dry run) | `import_from_card` |
| `list_rules` / `list_trips` | |

`undo_last` is always allowed regardless of trust: an escape hatch that
needs permission is not an escape hatch.

`ask_user(question, options)` is also a tool. That is how "ask me when it is
not clear" becomes real rather than aspirational — an uncertain model has
somewhere to go that is not guessing.

## Graduated trust

Trust is **per action type**, earned, and always visible:

1. Everything writeable starts at **ask** — preview, you approve.
2. After repeated approvals with no undo, it offers to promote that one
   action to **ghost** (below). Approving rule application never implies
   permission to import or delete.
3. **Ghost** runs the action on schedule and writes to the audit log what it
   *would* have done, touching nothing. After a week of real, messy footage
   the log is the evidence for promoting it to **auto** — or for not.
4. A Trust screen lists where every action sits, with one-click revert, and
   any undo immediately demotes that action back to **ask** — undoing is the
   clearest possible signal that trust was premature.

Ghost mode is nearly free to build: `sortEngine.plan()` is already a pure
read-only dry run, so this is running it on a timer and logging the result
without ever calling `apply()`. It is also the better promotion signal —
evidence about *outcomes on real data* rather than a tally of how many times
someone clicked approve.

Every automatic action is written to an audit log with what ran, why, and
what moved. "It arranged things while I was out" is only acceptable if
"what exactly did it do" has an exact answer.

## O1 — The Adaptive Pattern Engine (shipped)

This grew well past "trips need no AI at all." The original sketch — a flat
~12h/50km cluster boundary — was elevated at your request into a real
pattern-recognition engine for multi-day, multi-camera motovlogging trips:
adaptive burst clustering, GPS anchoring across cameras, per-camera
clock-drift correction, VLM-tag semantic bridging across ambiguous gaps, and
a Ghost Mode review loop that proposes structured (AST) rules rather than
acting on its own. The elevated design was stress-tested by a Plan agent
before any of it was built, which caught real problems worth recording here
rather than letting them stay implicit in the code:

- **`captured_at` mixed two clock bases** — naive local time for photos,
  genuine UTC for video — which would have made drift detection "discover"
  nothing but ordinary timezone offset. Fixed first, as its own step:
  `captured_at_basis` (`'utc'` / `'utc-gps'` / `'local-naive'`), using a
  photo's own GPS fix timestamp (GPSDateStamp/GPSTimeStamp — genuinely UTC,
  independent of the camera's local clock) as the trustworthy anchor when
  present.
- **Video files never got `camera_make`/`camera_model`** — blocking the
  camera-model-keyed drift correction this phase exists for, for exactly the
  video-first device class (drone, action cam) it targets. Fixed alongside.
- **My own draft's schema was wrong.** A `trip` column (and inferred GPS
  columns) directly on `files` would have been silently wiped the instant a
  trip-triggered rule moved the file — `lib/indexer.js` deletes and
  reinserts a file's row on every move, never updates it in place. Every
  piece of machine-derived data here is hash-keyed instead, mirroring
  `content_embeddings`'s already-proven precedent, and resolved fresh at
  evaluation time (`tripFor()`, `correctedCapturedAt()` in
  `lib/sort-engine.js`) the same way `resolvedGeocoder()` already resolves
  "gps near" clauses.
- **Reverse-geocoding was not "already built."** `lib/geocode.js` was
  forward-only; a genuinely new `reverseGeocode()` was needed.

**Clustering.** `lib/trip-clustering.js`'s `detectBursts()` pools every
camera's timestamps into one chronological sequence and finds a boundary
where the gap exceeds `max(minGapMs, k × runningMean)` — a self-relative
threshold (Welford's-style running mean, seeded from the *median* gap
rather than the first one seen, since a first-gap seed can be poisoned by
one early large gap into merging genuinely separate events) rather than one
fixed number. `interpolateLocations()` anchors a non-GPS camera's shots from
its nearest GPS-bearing neighbours *before and after* in time — never a
one-sided guess — gated by an implied-speed sanity check
(distance ÷ elapsed time against a plausible ground-transport ceiling)
rather than a flat distance cap, which alone cannot catch "close in km but
unreachable in the time window."

**Clock drift.** `estimateDrift()` proposes a per-camera offset only when a
dual bar clears: enough mutually-consistent evidence, *and* that evidence
not cherry-picked from a much larger noisy pool — measured only against
GPS-fix-verified baseline shots, never another camera's own possibly-wrong
clock. Applied as an index-only overlay at evaluation time, never written
back into a file's EXIF — the same "never mutate the source" rule this app
has followed from the start, extended to a derived value. Per your answer,
an approved correction can graduate to full trust like any other action
type; the dual-bar evidence check gates whether a correction is *proposed*
at all, independent of how much trust has been earned.

**Semantic bridging.** For a boundary the burst detector finds genuinely
ambiguous (its gap sits within roughly half to one-and-a-half times the
threshold that decided it — not clearly a boundary, not clearly not one),
Discovery checks whether the two bracketing files' visual tags share a
recurring term ("tent", "Himalayan 450"). Tags are read from `content_tags`
first (mirroring `content_embeddings`'s hash-keyed shape); per your answer,
Discovery may also call a live VLM for just those bracketing files, capped
per run, rather than only ever reading tags computed at import time — so
the honest framing is that trips need *no AI* for the common case, and a
small, bounded, occasional local-model call for a boundary that's genuinely
unclear otherwise, not a hard guarantee against AI ever running.

**Ghost Mode.** `lib/pattern-discovery.js`'s `runDiscoveryPass()` reads the
whole library, clusters it, and writes one `rule_proposals` row per finding
— structured JSON (an AST), never DSL text a parser has to rescue, matching
the "structured output" principle above. Re-running is idempotent: a
still-pending or already-rejected candidate is not re-proposed. Per your
answer, a new file landing inside an *already-approved* trip's own envelope
(camera, capture time, and — with a buffer generous enough to absorb
ordinary GPS noise — location) auto-attaches directly, no new proposal.
Approving a proposal is just another editor of the saved rules file, going
through the exact same `rulesVersion()`/`RulesConflictError` concurrency
check a human edit already uses.

Named `lib/pattern-discovery.js`, not `lib/discovery.js` — that name
already belongs to mDNS LAN host discovery, an unrelated module.

**What O1 does not yet do:** wire a real Moondream2 call behind the
semantic-bridge tie-break (the decision logic and the `content_tags`
storage are real and tested; `tagImage` is a pluggable function, not yet
pointed at Ollama); detect that a re-clustering looks like it should
*split* an already-approved trip (the schema's `supersedesId` fully
supports this, but nothing yet triggers it automatically — approving a
supersession today would need a proposal created by hand, or a future
pass); or any review UI beyond the admin JSON API
(`/api/pattern-engine/*`) — a desktop/gallery screen for the queue is
natural O4 work, not built here.

## O2 — Tool layer + trust (shipped, scoped to O1's two action types)

Graduated trust, exactly as designed above, wired to `trip_cluster` and
`camera_correction` — the two action types O1 built. Not the *general* tool
inventory (`save_rule`, `apply_rules`, `run_once`, `import_from_card`)
described in "The tool layer is the actual design" above; wiring trust
generically across every write action is O3's job, once there is an actual
tool-calling loop deciding which one to invoke. This is the trust *ladder
mechanism* proven real end to end on the two action types that already
exist, not the whole inventory.

- `lib/trust.js` — three levels (`ask`/`ghost`/`auto`) per action type,
  stored in `config.json`. Promotion is *offered*, never automatic, per the
  "it offers to promote" language above: `promotionEligibility()` computes
  the evidence (a consecutive-approval streak for ask→ghost, a
  consecutive-ghost-log streak for ghost→auto) and a caller decides whether
  to surface an offer. Demotion is the one unconditional path — any revert
  demotes immediately.
- `lib/index-db.js` gained `audit_log` — every *automatic* decision
  (`auto-approved` / `ghost-logged` / `demoted`), never a direct human
  action (`rule_proposals.decided_at`/`status` already covers those). This
  is what makes "it arranged things while I was out" answerable.
- `lib/pattern-discovery.js`'s `runDiscoveryPass()` now checks trust for
  every new proposal: `ask` behaves exactly as O1 shipped it; `ghost` logs
  what *would* happen without touching anything; `auto` calls the real
  `approveProposal()` immediately — auto-running is not a second, less-
  checked path, it's the same one a human's click already uses. New:
  `revertProposal()`, the undo escape hatch — reverses an approved
  proposal (removing its appended rule line, via new `removeRuleLine()`)
  and demotes that action type back to `ask`.
- `lib/config.js` gained `configVersion()`/version-checked `save()` —
  the compare-and-swap this section flagged as owed back when the same bug
  was fixed for the rules file. Trust-state writes are its first real
  caller; every existing caller that omits a version keeps working exactly
  as before.
- Routes: `GET/POST /api/trust`, `GET /api/audit-log`,
  `POST /api/pattern-engine/proposals/:id/revert` — all admin-gated,
  mirroring the existing `/api/sort-rules/*`/`/api/pattern-engine/*`
  pattern. No UI yet (see O4).

## O3 — The loop (shipped)

"The model drafts, a person approves, tested code executes" carries over
unchanged from Phase M's one-line rule drafting — the model now picks
*which* tested code to run, but every write it can reach still only ever
does what the trust-gated tool layer below already allows.

- `lib/assistant-tools.js` — the general tool inventory this section
  promised: read tools (`search_library`, `describe_library`, `detect_trips`,
  `preview_rule`, `list_rules`, `list_trips`) always just run; write tools
  (`save_rule`, `apply_rules`, `run_once`) each carry a `preview` alongside
  `execute`, which is what lets `invokeTool()` apply *any* current trust
  level to *any* of them — `ask`/`ghost` return the preview only (`ghost`
  also logs it), `auto` actually runs it — the exact mechanism O2 proved on
  Ghost Mode's two proposal kinds, now generic. `undo_last` always executes
  for real regardless of trust, per "an escape hatch that needs permission
  is not one." `ask_user` is in the schema the model sees but carries no
  `execute` at all — answering it means pausing the loop, so
  `lib/assistant.js` intercepts it by name before it would ever reach
  `invokeTool()`.

  `import_from_card` is not a tool yet — wiring it safely needs either a
  real capture device or a properly simulated one to test against, a
  separate piece of work.

- `lib/assistant.js` — the loop itself, talking to Ollama's `/api/chat`
  with OpenAI-style function-calling `tools`. **Hermes 3 8B** (`hermes3:8b`)
  is the default model, per the earlier model-choice section — verified
  available on this machine, sized for its 6 GB card. Error handling
  mirrors `lib/nl-rules.js` exactly (a 404 names the missing model and what
  is installed instead; a non-OK response surfaces Ollama's own error body).
  A model that keeps calling tools without ever answering is cut off after
  a bounded number of calls rather than looping forever.

- **Machine guesses are never stored as facts, applied to memory too.**
  `lib/assistant-memory.js`'s `closestExamples()` retrieves the few most
  relevant past instruction/rule pairs via keyword-overlap scoring — a
  second embedding pipeline just to rank a few dozen short strings would be
  more machinery than the problem needs, when this project already has one
  (`lib/clip.js`, for images) doing something genuinely different. Stored
  as the corrected pair, never as "the model said X and X was wrong," per
  the framing this section committed to. Corrections outrank an ordinary
  acceptance at equal overlap; the single most recent correction always
  surfaces regardless of topic.

- Routes: `POST /api/assistant/message` (one turn; stateless server-side —
  the client holds and resends the conversation, same shape a plain chat
  completion API already has), `GET/POST /api/assistant/models` (its own
  model setting, `config.assistant.model`, separate from Phase M's
  rule-drafting model). All admin-gated.

**What O3 does not yet do:** a chat UI to actually talk to it (see O4);
automatic detection of *which* save_rule calls were corrections versus
plain acceptances — `rememberInstruction()`'s `isCorrection` flag is real
and tested, but nothing yet sets it from conversation flow alone, since
that needs an explicit "no, I meant this" UI action to mean anything
honestly, which is O4 work too; and `import_from_card` as a tool, noted
above.

## O4 — Chat UI (shipped, desktop only)

Two new screens in the desktop app, wired through new IPC handlers that
call the exact same `lib/assistant.js`/`lib/trust.js`/
`lib/pattern-discovery.js` functions the HTTP routes already use — the
desktop chrome is a second front door onto the same tested logic, never a
second, less-checked implementation of it.

- **Assistant** — a real conversation panel. Every tool call the model
  makes shows up as its own quiet log line, not folded invisibly into the
  reply, so "what exactly did it do" (Graduated Trust's own standard,
  applied here to the chat itself) stays visible turn by turn. An
  `ask_user` question renders as clickable option buttons. The
  conversation is held client-side across panel switches, matching the
  stateless-server design O3 chose; "New conversation" resets it.
- **Automation** — the Trust screen and Ghost Mode review queue O1/O2
  built the routes for but had no UI: a select per action type
  (ask/ghost/auto) with a promotion-eligibility hint the moment one is
  earned, the pending-proposal queue with Approve/Reject, a
  recently-approved list with Revert (which demotes trust straight back to
  Ask, matching the backend's own rule), and a compact recent-activity view
  of the audit log.

**Verified:** both new files pass a syntax check, and
`test/ui-contracts.mjs` (every id the new JS looks up exists in the HTML,
and the new `.chat-log`/`.chat-msg` rules don't reintroduce the `[hidden]`
CSS cascade bug this session hit twice already). **Not verified:** actually
clicking through the panels in a live window — this environment has no
display server to render a native Electron window in, so hands-on
verification in the real desktop app is still owed before a release build.

**What O4 does not yet do:** any of this in the web gallery (`public/`) —
only the desktop app; a way to mark a chat correction as a correction, so
`assistant_memory.isCorrection` still only gets set by an ordinary
`save_rule` call (see O3's own gap above) — the honest fix needs a "no, I
meant this" affordance in the chat panel itself, not built here.

## Order of work

Each lands useful alone; none requires the next.

- **O1 — The Adaptive Pattern Engine.** Shipped, per the section above:
  clustering, GPS anchoring, clock-drift correction, semantic bridging, and
  the Ghost Mode proposal queue with admin routes.
- **O2 — Tool layer + trust.** Shipped, scoped to O1's two action types (see
  the section above): the trust ladder mechanism, promotion evidence,
  demotion, audit log, and version-checked config writes, proven real end
  to end. Extending trust generically across every write action (`save_rule`,
  `apply_rules`, `run_once`, `import_from_card`) is O3's job below, once a
  tool-calling loop exists to decide which one to invoke.
- **O3 — The loop.** Shipped, per the section above: Hermes 3 backend, the
  general trust-gated tool layer, `ask_user`, corrected-pair memory fed into
  prompts, and the chat routes. The backend behaves like an assistant now —
  there is just nothing to talk to it with yet.
- **O4 — Chat UI.** Shipped for the desktop app (see the section above): the
  conversation panel, plus the Trust and Ghost Mode review screens O1/O2
  built the routes for. The web gallery still has none of this — desktop
  only, for now.
- **O5 — Cloud on demand.** Second backend, "think harder", the disclosure UI.

## Concurrent writers: correctness first, realtime second

Two tabs, or a person and the assistant, can both load the rules, both edit,
and both save. Node's event loop does not prevent this — the read and the
write are separate requests with a human-length gap between them — and
`POST /api/sort-rules` had no version check at all: the second save silently
erased the first and reported success. A real bug, present before Phase O
adds a second writer and worse once it does. **Fixed**, ahead of the rest of
this phase, since it was live: `lib/sort-rules.js` gained `rulesVersion()`
(a hash of the current text) and `saveRulesText()` an `expectedVersion`
check, `RulesConflictError` on a mismatch carrying the current text back so
an editor can reconcile rather than losing work silently. Wired through the
HTTP route (`ETag` / `If-Match`, 409 on conflict) and the desktop IPC path
identically. `config.json`'s trust-state writes need the same
compare-and-swap once Phase O adds them — noted here so it is not
forgotten a second time.

A WebSocket was the first instinct and is the wrong first fix: pushing
"rules changed" to open tabs makes staleness *less likely*, it cannot make a
concurrent write *impossible* — two tabs can still race inside the
notification window. Optimistic concurrency is what actually prevents the
lost update; a realtime channel is a freshness nicety on top of that, not a
substitute for it. It still earns a place later — streaming assistant
tokens and live ghost-mode activity are exactly the case polling is the
wrong tool for — just after correctness, not instead of it.

## Risks, stated plainly

- **An 8B model will pick the wrong tool sometimes.** Mitigated structurally,
  not by hoping: reads are harmless, writes preview, trust is earned per
  action, everything undoes. This is why the tool split exists.
- **Context is finite.** A library of 50,000 files cannot be described to a
  model. Tools query and summarise; the library is never dumped into the
  prompt.
- **Trust automation is the risky part of this phase**, in the same way
  two-way sync was of Phase D. Demote-on-undo, the audit log, and per-action
  granularity are the mitigations, and none of them is optional.
- **"Learns" will be over-read** by anyone who did not read this section.
  Worth repeating wherever it is described in the UI.
- **A stored tag is a guess wearing the same shape as a fact**, and the one
  thing this section insists cannot be allowed to happen quietly. Enforced
  by keeping tags in their own column with their own rule syntax, never
  merged into the fields EXIF already owns.

## Reviewed before any of it was built

This design was put in front of a second reviewer before O1 started, on the
theory that an architecture this consequential is cheaper to correct on
paper. Four changes came from that pass, all folded in above rather than
left as a separate list: schema-constrained tool/rule output, VLM tags kept
structurally apart from EXIF facts, ghost mode as the step between ask and
auto, and corrected-pair retrieval instead of showing the model its own
mistake. The review also named a real bug already live in `/api/sort-rules`
— a lost update on concurrent saves — which is fixed above rather than
merely noted, since it did not need Phase O to already be a problem.

---

## Worth adding, not in the original vision

- **Duplicate detection.** Merging several devices into one view will surface
  the same file many times over. Content hashing is already there for other
  reasons, so this is nearly free and makes the merged view usable at all.
- **Last-copy protection.** Warn before deleting a file the index believes
  exists nowhere else. Knowing that is the whole point of a central view.
- **A push-to-cloud policy that never deletes.** *"…and store it in Google
  Drive"* needs one. Today `mirror` would push *and delete* whatever Drive holds
  that the library does not — wrong here, and destructive on a shared folder.
  It is the mirror image of the `pull` policy, and small.
- **Undo for anything automatic.** Rules and imports move files without asking
  each time. One batch, one undo.
- **Stale-index honesty.** Show when a machine was last seen rather than
  implying its answer is current.
- **Text extraction, later.** OCR and PDF text would make "all files" genuinely
  searchable rather than searchable by name. Real work; worth its own phase if
  it turns out to matter.

## Fix on the way through

- **Firewall rules are added without checking for duplicates**, so every setup
  run stacked more — ten on this machine after a handful of runs — and neither
  the app nor the uninstaller removes them.
- **The uninstaller leaves a 203 MB installer cache** behind in
  `%LOCALAPPDATA%\lanshare-updater`.

## Risks, stated plainly

- **Automatic sorting is the riskiest thing here.** It moves files without
  asking each time. Dry runs, batch undo, and never deleting from a source are
  the mitigations, and none of them is optional.
- **A stale index is worse than no index** if presented as current — the file it
  promises may be gone. Labelling and last-seen times are the fix.
- **The natural-language layer will misread instructions.** Bounded by never
  letting it act: it drafts, a preview shows, a person approves.
- **Encrypted index history will bloat git** unless managed deliberately.
- **Scope.** H–N is comparable in size to A–G together. H and I alone deliver
  most of the daily value; K and L are what make it feel automatic; M is the
  polish on top.
