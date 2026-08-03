'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

for (const item of document.querySelectorAll('.nav__item')) {
  item.addEventListener('click', () => {
    if (item.disabled) return;
    for (const el of document.querySelectorAll('.nav__item')) el.classList.remove('is-active');
    for (const el of document.querySelectorAll('.panel')) el.classList.remove('is-active');
    item.classList.add('is-active');
    $(`panel-${item.dataset.panel}`).classList.add('is-active');
  });
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function formatAddress(scheme, host, port) {
  return `${scheme}://${host}:${port}`;
}

function render(status) {
  const running = status.running;

  // Nav rail indicator
  $('navStatus').classList.toggle('is-running', running);
  $('navStatusLabel').textContent = running ? 'Running' : 'Stopped';

  // Status card
  $('statusRow').classList.toggle('is-running', running);
  $('statusLabel').textContent = running
    ? `Running on port ${status.port}`
    : 'Stopped';
  $('toggleBtn').textContent = running ? 'Stop' : 'Start';
  $('toggleBtn').className = `btn ${running ? 'btn--danger' : 'btn--primary'}`;

  $('ffmpegNote').textContent = status.ffmpegReady
    ? ''
    : 'ffmpeg was not found — video thumbnails and HEVC playback for non-Apple devices are disabled.';

  // First-run password banner
  if (status.generatedPassword) {
    $('firstRunCard').hidden = false;
    $('firstRunPassword').textContent = status.generatedPassword;
  }

  // Addresses
  const addrList = $('addrList');
  addrList.textContent = '';
  if (running) {
    const rows = [
      { tag: 'This PC', value: formatAddress('http', 'localhost', status.port) },
      ...status.addresses.map((ip) => ({ tag: 'LAN', value: formatAddress('http', ip, status.port) })),
      { tag: 'Apple', value: formatAddress('http', status.mdnsHost, status.port) },
    ];
    if (status.httpsPort) {
      rows.push({ tag: 'Secure', value: formatAddress('https', status.addresses[0] || status.mdnsHost, status.httpsPort) });
    }
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'addr';
      el.innerHTML = `<span class="addr__tag"></span><span class="addr__value"></span>`;
      el.querySelector('.addr__tag').textContent = row.tag;
      el.querySelector('.addr__value').textContent = row.value;
      addrList.append(el);
    }
  } else {
    const el = document.createElement('p');
    el.className = 'panel__sub';
    el.style.margin = '0';
    el.textContent = 'Start the server to see addresses here.';
    addrList.append(el);
  }

  // QR
  $('qrWrap').hidden = !(running && status.qrDataUrl);
  if (status.qrDataUrl) $('qrImg').src = status.qrDataUrl;

  $('libraryPath').textContent = status.library;
}

async function refresh() {
  const status = await window.lanshare.getStatus();
  render(status);
}

$('toggleBtn').addEventListener('click', async () => {
  $('toggleBtn').disabled = true;
  try {
    const status = $('toggleBtn').textContent === 'Start'
      ? await window.lanshare.startServer()
      : await window.lanshare.stopServer();
    render(status);
  } finally {
    $('toggleBtn').disabled = false;
  }
});

$('openLibraryBtn').addEventListener('click', () => window.lanshare.openLibraryFolder());
$('quitBtn').addEventListener('click', () => window.lanshare.quit());

window.lanshare.onStatusChanged(refresh);
refresh();
