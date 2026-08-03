# LANShare

Your photos and videos, on your own network.

Run it on your laptop and every device in the house — iPhone, iPad, Mac,
Android, another PC — signs in through a browser to view, upload, download and
organise your library at full LAN speed. Nothing leaves your network and
nothing touches a cloud account.

---

## Quick start

Double-click **`start.bat`**.

On first run it installs what it needs and creates an account, printing the
password once:

```
  First run - an account was created for you:
    username:  admin
    password:  7cFJEKHyPb
```

**Write that password down.** Then it shows where to connect:

```
  Open on this laptop:
    http://localhost:8420

  Open on your phone, tablet or another computer:
    http://192.168.1.20:8420
    http://msi.local:8420   (iPhone & Mac)
```

A QR code appears underneath — point your phone's camera at it.

Change the password any time:

```bash
npm run setup
```

## Opening it on your phone

Any device on the same Wi-Fi can use the address above. On an iPhone or a Mac,
prefer the `.local` address: it keeps working after your router hands the
laptop a different IP.

**Add it to your home screen** so it opens like a real app:

- **iPhone / iPad** — open it in Safari, tap Share, then *Add to Home Screen*.
- **Android / Chrome / Edge** — use the HTTPS address (below) and the browser
  will offer *Install*.

## The HTTPS address

The server also listens on `https://<your-ip>:8443` with a certificate it
generates for itself. You need this for the Install button on Android and
desktop Chrome — browsers only allow app installation on a secure connection.

Because the certificate is self-signed, each device has to be told to trust it
once. Download it from `http://<your-ip>:8420/cert`.

**On iPhone or iPad this is a two-step process, and the second step is the one
everyone misses:**

1. Open `http://<your-ip>:8420/cert` in Safari and allow the profile to
   download. Then go to **Settings → General → VPN & Device Management** and
   install it.
2. Now go to **Settings → General → About → Certificate Trust Settings** and
   switch it on for LANShare. Until you do this, Safari still refuses the
   connection.

On a Mac: open the downloaded `.crt`, find it in Keychain Access under
*System*, and set it to *Always Trust*.

Plain HTTP on port 8420 keeps working throughout and is slightly faster, since
nothing has to be encrypted. On a home network that is a perfectly reasonable
choice — the trade-off is that your password is sent in the clear over your own
Wi-Fi, and Chrome will not offer to install the app.

## If other devices cannot connect

Windows Firewall blocks incoming connections to new programs by default. Run
this once in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "LANShare" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8420,8443
```

Also check that the laptop and the phone are on the same network — a "guest"
Wi-Fi network usually cannot see the main one.

---

## What it does

**Photos and videos first.** Files appear as a mosaic of tiles with real
thumbnails, newest first, with folders as albums. Tap one for a full-screen
viewer with swipe and arrow-key navigation.

**It handles iPhone media properly.** This is the part most home servers get
wrong:

- **HEIC photos** are converted on the fly for browsers that cannot decode
  them. Safari receives the original untouched.
- **HEVC video** — what your iPhone actually records into `.mov` — plays
  natively in Safari. For Chrome, Firefox and Android, the server transcodes to
  H.264 as it streams, so the video simply plays instead of showing a black
  rectangle.
- **Rotation is respected**, so portrait photos are not sideways.

**Uploads are streamed,** never buffered in memory, so file size is limited
only by your disk. Three upload in parallel with live speed and time
remaining. Drag a whole folder onto the window and its structure is preserved.

**Deletes are recoverable.** Anything you delete moves to
`library/.lanshare/trash/`, not oblivion.

**Downloads** stream with byte-range support, so video scrubbing works and
interrupted transfers resume. Select several items to get them as a zip.

---

## Where things live

| Path | What it is |
|---|---|
| `library/` | Your photos and videos. Back this up. |
| `library/.lanshare/thumbs/` | Thumbnail cache. Safe to delete; it rebuilds. |
| `library/.lanshare/trash/` | Deleted items. Empty it yourself when ready. |
| `library/.lanshare/tls/` | The HTTPS certificate. |
| `config.json` | Password hash, session secret, port, library location. |

`config.json` and `library/` are excluded from git, so no media, password
hashes or session secrets can be committed.

### Settings

Edit `config.json` and restart:

```json
{
  "port": 8420,
  "httpsPort": 8443,
  "library": "D:\\projects\\filesharing\\library",
  "sessionDays": 30
}
```

Point `library` at any folder — an existing photos folder works, and files are
read and written in place. Set `httpsPort` to `0` to disable HTTPS entirely.

---

## Building the .exe

```bash
npm run build
```

Produces `dist/LANShare.exe`: one file, no Node.js and no ffmpeg needed on the
machine that runs it. Copy it anywhere and double-click.

ffmpeg and sharp's image library are embedded and unpacked to
`%LOCALAPPDATA%\LANShare\runtime\` the first time you run it — native code
cannot execute from inside a packed executable, so it needs real files on disk.
The first launch spends about a minute on that; after that it does not.

`config.json` and `library/` are created **next to the .exe**, so the whole
thing is portable: put `LANShare.exe` in a folder and that folder becomes your
library.

**It takes about 10 seconds to start.** The 370 MB of embedded binaries are
Brotli-compressed to fit in a 170 MB file, and that has to be unpacked into
memory on every launch. Since this is a server you start once and leave
running, that seemed the better trade against a 440 MB uncompressed file.

Build it on a machine that has ffmpeg on its PATH, otherwise the executable
works but cannot make video thumbnails.

## Running from source

```bash
npm install
npm start
```

Requires Node.js 18 or newer. ffmpeg is optional — without it, photos work
fully and videos still play, but there are no video thumbnails and no HEVC
conversion.

## Tests

Start the server, then in another terminal:

```bash
node test/smoke.mjs <password>
```

- `test/smoke.mjs` — auth, path traversal, range requests, upload round-trip,
  album management, zip.
- `test/media.mjs` — thumbnails, metadata, HEVC detection and live transcoding.
  Run `npm run samples` first to generate the fixtures.
- `test/pwa.mjs` — HTTPS, and every requirement a browser checks before it
  offers to install the app.
- `test/throughput.mjs` — a 1 GB round trip with an end-to-end checksum. This
  is what would catch a regression of the upload timeout fix.

---

## A note on security

LANShare is built for a home network, and its defaults reflect that:

- Sign-in is required for everything, passwords are hashed with scrypt, and
  repeated guesses are throttled.
- Every path from a browser is validated, so nothing outside your library
  folder can be read or written.
- Sessions last 30 days so your phone stays signed in.

It is **not** built to face the open internet. Do not forward a port to it. If
you want access from outside the house, use a VPN such as Tailscale or
WireGuard and connect to it as though you were at home.
