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
| H | Metadata and search — the foundation | Not started |
| I | Search across every machine | Not started |
| J | A central index every device can reach | Not started |
| K | Import on connect — cameras, drones, cards | Not started |
| L | Sorting rules, versioned in git | Not started |
| M | Instructions in plain language | Not started |
| N | Content search — the fuzzy cases | Not started |

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
dimensions, duration. Maintained incrementally by watching the library, not by
rescanning it.

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

## N — Content search

For what metadata cannot answer: "photos of whiteboards", "the one with the red
bike". CLIP embeddings computed locally, roughly 1–2 GB of model, comfortable on
this GPU. Optional, and last, because metadata answers most questions first and
answers them exactly.

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
