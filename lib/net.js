'use strict';

const os = require('os');

/**
 * Every IPv4 address other devices could reach us on, best candidate first.
 * Virtual adapters (VirtualBox, WSL, Docker, Hyper-V) are pushed to the back —
 * they are almost never the address a phone should use.
 */
function lanAddresses() {
  const found = [];
  const interfaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      found.push({ name, address: addr.address, virtual: isVirtual(name, addr.address) });
    }
  }

  found.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    // 192.168.x is the typical home network; prefer it over 10.x corporate ranges.
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return score(a.address) - score(b.address);
  });

  return found;
}

function isVirtual(name, address) {
  if (/virtualbox|vmware|hyper-v|wsl|docker|loopback|bluetooth|vethernet/i.test(name)) return true;
  // 169.254.x.x means DHCP failed; nothing useful is reachable there.
  return address.startsWith('169.254.');
}

/** The address to print first and encode in the QR code. */
function primaryAddress() {
  const list = lanAddresses();
  return list.length ? list[0].address : '127.0.0.1';
}

/**
 * Bonjour/mDNS name. Macs and iPhones resolve this without any configuration,
 * and it survives a DHCP lease change that would break a hard-coded IP.
 */
function mdnsHost() {
  const host = os.hostname().split('.')[0].toLowerCase();
  return `${host}.local`;
}

function printBanner({ httpPort, httpsPort, library, ffmpegReady }) {
  const addresses = lanAddresses();
  const primary = primaryAddress();
  const url = `http://${primary}:${httpPort}`;

  // Plain ASCII here: a Windows console on the legacy code page renders
  // box-drawing characters and em dashes as mojibake.
  const line = '='.repeat(56);
  console.log(`\n  ${line}`);
  console.log('   LANShare - your photos and videos, on your own network');
  console.log(`  ${line}\n`);

  console.log('  Open on this laptop:');
  console.log(`    http://localhost:${httpPort}\n`);

  if (addresses.length) {
    console.log('  Open on your phone, tablet or another computer:');
    console.log(`    ${url}`);
    console.log(`    http://${mdnsHost()}:${httpPort}   (iPhone & Mac)`);
    for (const extra of addresses.slice(1)) {
      console.log(`    http://${extra.address}:${httpPort}   (${extra.name})`);
    }
    console.log('');
  } else {
    console.log('  No network connection detected - only this laptop can connect.\n');
  }

  if (httpsPort) {
    console.log('  Secure address (needed to install the app on Android/Chrome):');
    console.log(`    https://${primary}:${httpsPort}`);
    console.log(`    Certificate to trust: http://${primary}:${httpPort}/cert\n`);
  }

  console.log(`  Library:  ${library}`);
  if (!ffmpegReady) {
    console.log('  Note:     ffmpeg not found - video thumbnails are disabled.');
  }
  console.log('');

  try {
    // eslint-disable-next-line global-require
    require('qrcode-terminal').generate(url, { small: true }, (qr) => {
      console.log('  Scan to open on your phone:\n');
      console.log(qr.split('\n').map((l) => `  ${l}`).join('\n'));
    });
  } catch {
    /* QR is a nicety, never a reason to fail startup */
  }

  console.log('  Press Ctrl+C to stop.\n');
}

module.exports = { lanAddresses, primaryAddress, mdnsHost, printBanner };
