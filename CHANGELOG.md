# Changelog

Versions are git tags on this repository. `v1.1.0` and later have an installer
built from that exact tag.

The version is shown in the app's left-hand rail, so "am I running the new
one?" is answerable without opening anything.

---

## 1.1.0 — 2026-08-11

**First-run setup.** A fresh install now walks through choosing a username and
password, where the library lives, the Windows firewall rule, and whether to
start with Windows. Previously a random password was generated and shown once,
on a screen that could be closed before it was read.

The firewall step matters more than it sounds: Windows silently drops incoming
connections, which is the usual reason a phone cannot see a running LANShare.
Nothing errors — the phone just times out.

**Download-only sync, for Google Drive and similar.** A new policy fetches
from a folder and never writes to it. The existing "mirror" runs the other
way and deletes whatever the target holds that the library does not, which on
a shared cloud folder is destructive; there was no correct option for
collecting *from* one.

**The installer is now unmistakable.** Three executables were called some
variant of `LANShare.exe` and only one installed anything. Now:

| File | What it does |
|---|---|
| `LANShare-Installer-<version>.exe` | installs the app |
| `win-unpacked/LANShare.exe` | runs it, installs nothing |
| `LANShare-Portable-NoInstall.exe` | runs the server in a console |

**Installing over an older version** now says what is already there and what
will replace it, rather than doing it silently. Photos, accounts and settings
are always kept, and uninstalling says where they were left.

### Fixed

- **A zero-byte file crashed the whole server.** An empty file has no last
  byte, so the usual `size - 1` was `-1` and the read threw — uncaught, inside
  a request handler, taking the process down for everyone on the network.
- **Concurrent uploads of the same filename lost photos.** Five at once left
  one file and two errors, because the name was checked and then written to.
  Phones upload in parallel and two photos sharing a name is unremarkable.
- **A sync could be pointed inside itself and grew without bound** — measured
  at 6 → 9 → 12 files over three runs, until the disk filled. Reachable,
  because a "drive" could be registered inside the library.
- **Deleting an album stored on another drive** removed only the shortcut,
  stranding the real photos on that drive with nothing pointing at them.
- **Files over 16 MB could not cross the internet tunnel at all** — which for
  a photo and video library is most of the point.
- **A first sync to a fresh drive** reported the drive as disconnected.
- **Visitors over the internet were recorded as local**, sharing a login
  throttle with someone at the keyboard, so a leaked pairing code could lock
  the owner out of their own machine.
- **The setup wizard's Finish button sat below the fold** in the default
  window, with the error line below it too — so a rejected password produced a
  message nobody could see, indistinguishable from a dead button.
- Refused filenames (`CON.jpg`, a trailing dot) returned 500 rather than 400,
  and clients retry 5xx.

---

## 1.0.0 — 2026-08-04

The library itself: browse, upload, download, albums, trash, zip. Accounts
with four roles and per-album restrictions. Revocable sessions. Encrypted
vaults, server-unlock and end-to-end. Albums that live on other drives.
Two-way sync. Connecting to other machines on the network. Reaching a machine
over the internet through a relay. Windows installer and a desktop control
panel.
