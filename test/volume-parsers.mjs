/**
 * Reading what diskutil and lsblk actually say.
 *
 * The macOS and Linux branches of lib/volumes.js cannot run on the machine
 * this was developed on, so the parsing is separated from the command that
 * feeds it and tested against real recorded output. That does not prove the
 * commands exist or take these flags — only real hardware proves that — but
 * it does cover the part most likely to be wrong: the shapes that break
 * naive parsing.
 *
 *   node test/volume-parsers.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const volumes = require(path.join(here, '..', 'lib', 'volumes.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

// ---------------------------------------------------------------------------
// macOS — `diskutil info /Volumes/…`
// ---------------------------------------------------------------------------

const APFS_INTERNAL = `
   Device Identifier:         disk3s1s1
   Device Node:               /dev/disk3s1s1
   Volume Name:               Macintosh HD
   Mounted:                   Yes
   Mount Point:               /

   File System Personality:   APFS
   Type (Bundle):             apfs
   Protocol:                  Apple Fabric
   SMART Status:              Verified
   Volume UUID:               1E2B6A88-3F0E-4A3E-9C29-9F1D0C2A5B77
   Disk / Partition UUID:     A8C2D9E1-77B4-4F55-8E1B-6C3D2A9F0E44

   Removable Media:           Fixed
   Media Type:                Generic
   Volume Total Space:        494384795648 Bytes (494.4 GB)
   Volume Free Space:         120933302272 Bytes (120.9 GB)
`;

{
  const v = volumes.parseDarwinInfo('/', APFS_INTERNAL);
  check('an APFS internal disk is read', v !== null);
  check('its volume UUID is the identity',
    v.id === '1E2B6A88-3F0E-4A3E-9C29-9F1D0C2A5B77', v.id);
  check('its name comes from Volume Name', v.label === 'Macintosh HD', v.label);
  check('an internal disk is not removable', v.removable === false);
  check('sizes are read as bytes, not the human-readable figure',
    v.sizeBytes === 494384795648 && v.freeBytes === 120933302272,
    `${v.sizeBytes}/${v.freeBytes}`);
}

const USB_DRIVE = `
   Device Identifier:         disk5s1
   Volume Name:               My Passport
   Mounted:                   Yes
   Mount Point:               /Volumes/My Passport

   File System Personality:   ExFAT
   Protocol:                  USB
   Volume UUID:               6E1C4B22-A0D5-4E88-B3F1-77C90A2E4D13

   Removable Media:           Removable
   Volume Total Space:        2000398934016 Bytes (2.0 TB)
   Volume Free Space:         1500299200512 Bytes (1.5 TB)
`;

{
  const v = volumes.parseDarwinInfo('/Volumes/My Passport', USB_DRIVE);
  check('a USB drive is recognised as removable', v.removable === true);
  check('and a name with a space survives', v.label === 'My Passport', v.label);
}

{
  // A Thunderbolt disk reports "Fixed" media but is plainly something you
  // unplug, which matters for sync-on-connect.
  const tb = USB_DRIVE.replace('Protocol:                  USB', 'Protocol:                  Thunderbolt')
    .replace('Removable Media:           Removable', 'Removable Media:           Fixed');
  check('a Thunderbolt disk still counts as removable',
    volumes.parseDarwinInfo('/Volumes/TB', tb).removable === true);
}

{
  // A network share has no UUID. Degrading to the path fallback is correct;
  // crashing or inventing an id is not.
  const smb = `
   Volume Name:               shared
   Mounted:                   Yes
   Mount Point:               /Volumes/shared
   Protocol:                  SMB
`;
  const v = volumes.parseDarwinInfo('/Volumes/shared', smb);
  check('a share with no UUID parses with a null id', v !== null && v.id === null, JSON.stringify(v));
  check('and still reports where it is mounted', v.mountPoint === '/Volumes/shared');
}

{
  const v = volumes.parseDarwinInfo('/Volumes/img', `
   Volume Name:               Installer
   Disk / Partition UUID:     11111111-2222-3333-4444-555555555555
`);
  check('a disk image falls back to its partition UUID',
    v.id === '11111111-2222-3333-4444-555555555555', v.id);
}

check('empty diskutil output is not a volume', volumes.parseDarwinInfo('/Volumes/x', '') === null);
check('and neither is a failed command', volumes.parseDarwinInfo('/Volumes/x', null) === null);

{
  const names = volumes.parseDarwinVolumeNames('Macintosh HD\nMy Passport\nTime Machine Backups\n');
  check('volume names are split on lines, never on spaces',
    names.length === 3 && names[1] === 'My Passport', JSON.stringify(names));
  check('an empty listing is an empty list', volumes.parseDarwinVolumeNames('').length === 0);
}

// ---------------------------------------------------------------------------
// Linux — `lsblk -J -b …`
// ---------------------------------------------------------------------------

const LSBLK_UBUNTU = JSON.stringify({
  blockdevices: [
    {
      uuid: null, label: null, mountpoint: null, size: 512110190592, rm: false, type: 'disk', fstype: null,
      children: [
        {
          uuid: 'A1B2-C3D4', label: null, mountpoint: '/boot/efi', size: 536870912,
          rm: false, type: 'part', fstype: 'vfat', fssize: 535805952, fsavail: 429496729,
        },
        {
          uuid: '9f8e7d6c-5b4a-3210-fedc-ba9876543210', label: 'ubuntu', mountpoint: '/',
          size: 511562547200, rm: false, type: 'part', fstype: 'ext4',
          fssize: 503395450880, fsavail: 214748364800,
        },
      ],
    },
    // Every installed snap looks like this. On a normal desktop there are
    // dozens, and none of them are a drive anyone means.
    {
      uuid: null, label: null, mountpoint: '/snap/firefox/3836', size: 91750400,
      rm: false, type: 'loop', fstype: 'squashfs',
    },
    {
      uuid: 'BACKUP-UUID-0001', label: 'Backup SSD', mountpoint: '/media/ishan/Backup SSD',
      size: 2000398934016, rm: true, type: 'disk', fstype: 'exfat',
      fssize: 2000000000000, fsavail: 1500000000000,
    },
  ],
});

{
  const list = volumes.parseLinux(LSBLK_UBUNTU);
  const byMount = Object.fromEntries(list.map((v) => [v.mountPoint, v]));

  check('the root filesystem is found', Boolean(byMount['/']), JSON.stringify(list.map((v) => v.mountPoint)));
  check('its UUID is the identity',
    byMount['/'].id === '9f8e7d6c-5b4a-3210-fedc-ba9876543210', byMount['/'].id);
  check('nested partitions are walked, not just top-level disks', Boolean(byMount['/boot/efi']));

  check('snap loop mounts are left out', !list.some((v) => v.mountPoint.startsWith('/snap/')),
    JSON.stringify(list.map((v) => v.mountPoint)));

  const backup = byMount['/media/ishan/Backup SSD'];
  check('an external disk is found under /media', Boolean(backup));
  check('and is marked removable', backup?.removable === true);
  check('with a label containing a space', backup?.label === 'Backup SSD', backup?.label);
  check('and byte counts rather than "1.8T"',
    backup?.sizeBytes === 2000000000000 && backup?.freeBytes === 1500000000000,
    `${backup?.sizeBytes}/${backup?.freeBytes}`);

  check('a device with no UUID is skipped rather than given a null identity',
    list.every((v) => v.id), JSON.stringify(list.filter((v) => !v.id)));
}

{
  // Older lsblk reports rm as the string "1" and has no mountpoints array.
  const older = JSON.stringify({
    blockdevices: [{ uuid: 'OLD-1', label: 'USB', mountpoint: '/media/usb', rm: '1', size: '8000000000' }],
  });
  const [v] = volumes.parseLinux(older);
  check('older lsblk reporting rm as a string still reads as removable', v.removable === true);
  check('and its size still parses', v.sizeBytes === 8000000000, String(v.sizeBytes));
}

{
  // Newer lsblk reports several mount points for one filesystem, which is
  // ordinary with btrfs subvolumes.
  const multi = JSON.stringify({
    blockdevices: [{
      uuid: 'BTRFS-1', label: 'system', mountpoints: ['/', '/home', null], rm: false, type: 'part', fstype: 'btrfs',
    }],
  });
  const list = volumes.parseLinux(multi);
  check('a filesystem mounted in two places is reported at both',
    list.length === 2 && list[0].mountPoint === '/' && list[1].mountPoint === '/home',
    JSON.stringify(list.map((v) => v.mountPoint)));
  check('and a null entry in that array is ignored', !list.some((v) => !v.mountPoint));
}

check('malformed lsblk output is an empty list, not a crash',
  volumes.parseLinux('not json at all').length === 0);
check('a failed lsblk is an empty list', volumes.parseLinux(null).length === 0);

// ---------------------------------------------------------------------------
// Windows — the one path that does run here, kept honest alongside the others
// ---------------------------------------------------------------------------

{
  const single = JSON.stringify({
    DriveLetter: 'C', FileSystemLabel: 'Windows', DriveType: 'Fixed',
    Size: 500000000000, SizeRemaining: 100000000000,
    UniqueId: '\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\',
  });
  // ConvertTo-Json returns a bare object for one result and an array for many;
  // treating the object as a list of its properties would produce nonsense.
  const [v] = volumes.parseWindows(single);
  check('a single Windows volume is not mistaken for a list of fields',
    v && v.mountPoint === 'C:\\', JSON.stringify(v));
  check('its GUID path is the identity', v.id.startsWith('\\\\?\\Volume{'), v.id);

  const many = volumes.parseWindows(JSON.stringify([
    JSON.parse(single),
    { DriveLetter: 'E', FileSystemLabel: null, DriveType: 'Removable', Size: 0, SizeRemaining: 0, UniqueId: null },
  ]));
  check('several volumes all come through', many.length === 2);
  check('a removable drive is marked as one', many[1].removable === true);
  check('an unlabelled drive falls back to its letter', many[1].label === 'E:', many[1].label);
  check('and a volume with no id keeps a null id rather than a fake one', many[1].id === null);
}

check('malformed Windows output is an empty list', volumes.parseWindows('{{{').length === 0);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
