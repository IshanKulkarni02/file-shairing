# LANShare

Your photos and videos, on your own machines.

Run it on a computer at home and every device in the house — iPhone, iPad,
Mac, Android, another PC — signs in through a browser to view, upload,
download and organise the library at full network speed. Some albums can be
encrypted so that even someone holding the disk cannot read them. Albums can
live on other drives. Drives can sync when you plug them in. Machines can
reach each other's libraries, including over the internet.

Nothing goes through anyone else's cloud unless you put it there.

---

## Quick start

**Windows:** run the installer from `dist-desktop/`, or double-click
`start.bat` to run from source. On first launch an account is created and the
password is printed once:

```
  First run - an account was created for you:
    username:  admin
    password:  7cFJEKHyPb
```

**Write that password down.** It is shown once and stored only as a hash.

Then open the address it prints on any device on your network:

```
  Open on this laptop:     http://localhost:8420
  From another device:     http://192.168.1.20:8420
```

**macOS and Linux:** see [Other platforms](#other-platforms) — the code is
there, but it has not been run on real hardware yet.

---

## What it does

### The library

Browse photos and videos by album, with thumbnails, full-screen viewing and
video playback that scrubs properly on iPhone. Upload by dragging a folder in;
the folder shape is kept. Select several files to move, rename, download as a
zip, or send to the trash — which is a folder, not a void, so a mistake is
recoverable.

HEIC photos and HEVC videos from an iPhone are converted on the fly for
browsers that cannot display them, so nothing looks broken on a PC.

### Accounts

Four cumulative roles: **viewer** (browse and download) → **contributor**
(+upload) → **manager** (+rename, move, delete) → **admin** (+accounts and
settings). Each account can be restricted to particular albums, so a guest can
be given `/Family` and see nothing else — not the files, not the folder names,
not even that anything else exists.

Sessions are revocable. The Devices screen lists every signed-in device and
revoking one takes effect on its very next request.

### Encrypted albums (vaults)

Mark an album as a vault and its contents are encrypted at rest with
AES-256-GCM. Two kinds:

- **Server-unlock** — you unlock it and the key lives in memory only, so
  thumbnails, previews and video scrubbing all keep working. Protects a stolen
  disk, a stolen backup, or a powered-off machine. Locks again on a timer.
- **End-to-end** — your browser holds the key and the server only ever sees
  ciphertext. The cost is stated up front rather than discovered later: no
  thumbnails, no previews, no video playback. Downloads only.

A vault can have several passphrases, so you can share access without sharing
your own. Recovery codes are available, and the app says plainly at the moment
of export that sharing a key **cannot be undone** — anyone holding it can
decrypt forever.

Files are encrypted in 1 MiB chunks, so byte-range requests still work and
video still scrubs. Filenames, folder structure, sizes and timestamps are
**not** encrypted — only contents. That is a deliberate, documented limit.

### Storage across drives

An album can be moved to an external disk, a second internal one, or a folder
your cloud service syncs. It keeps working exactly as before on every device —
its path does not change, because a link takes its place. Drives are tracked
by volume id rather than drive letter, so a disk that comes back as `F:`
instead of `E:` is recognised and repointed automatically.

Unplug the drive and the album is still listed, marked as unreachable with the
drive's name — not silently vanished.

### Sync

Keep an album mirrored to another drive, in both directions, on demand or
automatically when that drive is plugged in.

It compares three states — this side, that side, and what matched last time —
because comparing only two cannot tell "added here" from "deleted there", and
that is why naive sync resurrects every file you delete. Nothing is ever
hard-deleted: removals go to a trash folder on the side being changed.
Encrypted albums are copied as ciphertext and never decrypted to be moved,
which is what makes a lost drive or a cloud copy safe.

When both sides changed the same file, the default keeps both — the only
policy that cannot lose work. "Newest wins" is available with its cost stated
where you choose it, because two machines' clocks disagree more often than
people expect.

### Other machines

The Machines screen finds other LANShare computers on your network and copies
files either way. Passwords for them are kept in your operating system's
keychain, never in a file.

Each host's certificate is pinned the first time you pair, the way SSH pins
host keys — there is no certificate authority on a home network, and simply
disabling verification would be plain HTTP wearing a padlock.

### Over the internet

Both machines connect **out** to a small relay you run, so neither needs
anything opened on its router. The relay pairs the two connections and copies
bytes; it cannot read a password, a photo, a filename, or even which page was
requested. See [`relay/README.md`](relay/README.md) for what it can and cannot
see, and how to run one.

If you would rather not run anything, Tailscale solves the same problem
without this feature.

---

## Opening it on your phone

Type the `http://192.168.x.x:8420` address into Safari or Chrome. Sign in
once and it stays signed in for 30 days.

To get an app icon rather than a browser tab, use the **HTTPS** address and
choose *Add to Home Screen* (iPhone) or *Install app* (Chrome). Chrome and
Edge only offer installation over HTTPS.

### The HTTPS address

LANShare generates its own certificate, which your browser has not been told
to trust — so the first visit shows a warning. That is expected on a home
network, where no certificate authority exists to vouch for your laptop.
Accept it once per device, or install the certificate offered at
`/cert` to stop the warning entirely.

---

## If other devices cannot connect

Almost always the firewall. On Windows, allow Node.js (or LANShare) on
**private** networks. Check the two machines are on the same network — a phone
on mobile data, or a "guest" Wi-Fi network, cannot see your laptop.

---

## Where things live

| What | Where |
|---|---|
| Photos and videos | `library/` (or wherever you moved it) |
| Config and accounts | `config.json` |
| Sessions | `.lanshare-server/sessions.json` |
| Thumbnails | `library/.lanshare/cache/` |
| Trash | `library/.lanshare/trash/` |

Running the desktop app, these live in your user data directory rather than
next to the program, because installation folders are often read-only and are
not where anyone expects their photos to end up.

---

## Running from source

```bash
npm install
npm start            # the server on its own
npm run desktop      # the desktop app
npm run build        # a single-file Windows .exe
npm run build:desktop  # the installer
```

Node 18 or newer. `npm run build:desktop` builds for the machine it runs on;
pass `--mac` or `--linux` only on that platform, since neither
cross-compiles usefully.

---

## Tests

```bash
npm test              # every suite
npm test -- --quick   # skip the slow ones
npm test -- vault     # just the suites matching "vault"
```

It starts its own throwaway library and server and cleans up afterwards, so it
never touches a real library and nothing needs starting by hand.

Around 770 checks across 25 suites. They exist because clicking through a UI
does not prove a security boundary: a viewer really is refused on every
privileged route, a revoked session really does stop working, a tampered
encrypted file really does fail authentication rather than returning wrong
bytes, and a deletion really does stay deleted across later syncs.

---

## Other platforms

macOS and Linux are written and packaged for — DMG, AppImage and `.deb` — but
**have not been run on real hardware**. Read that as "ready to try", not
"known working". The parts that could be tested from a Windows machine are:
the `diskutil` and `lsblk` parsers are unit-tested against real recorded
output, and the Linux autostart entry is tested, because Electron's own
autostart API silently does nothing there.

macOS builds are unsigned without an Apple Developer account, so Gatekeeper
refuses them on first launch — right-click → Open, once. That is Apple policy,
not something the code can work around.

---

## A note on security

This is built for a home network and for keeping your own photos private on
your own hardware. The encryption uses standard constructions in standard
ways, and the threat model is a stolen disk, a stolen backup, or a cloud copy
you do not control.

It is **not** an audited product, and it is not a defence against someone who
already has access to your unlocked machine.

Known limits, stated rather than buried: vault filenames and folder structure
are not encrypted, only contents; sharing a vault key cannot be revoked
without re-encrypting; and the first connection to a new machine trusts its
certificate blindly, exactly as SSH does.
