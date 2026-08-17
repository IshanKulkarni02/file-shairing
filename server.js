'use strict';

// Must run before anything pulls in sharp: in a packaged build this unpacks
// the native binaries and redirects sharp at them. No-op under plain node.
// This has to stay in the entry point — lib/server-app.js can be loaded more
// than once in the same process (the desktop app does exactly that), and the
// bootstrap must happen exactly once, before the first require('sharp')
// anywhere in the dependency graph.
require('./lib/runtime').init();

const configLib = require('./lib/config');
const ffmpeg = require('./lib/ffmpeg');
const net = require('./lib/net');
const serverApp = require('./lib/server-app');

// Loaded before any error handling further down can help, so a config that
// cannot be read is reported here as the one-line explanation it is, rather
// than as an uncaught parse stack trace from inside lib/config.js.
let config;
let generated;
try {
  ({ config, generated } = configLib.loadOrCreate());
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

if (process.env.PORT) config.port = Number(process.env.PORT);
if (process.env.HTTPS_PORT !== undefined) config.httpsPort = Number(process.env.HTTPS_PORT);

async function main() {
  let handle;
  try {
    handle = await serverApp.start(config);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.port} is already in use.`);
      console.error('  Close the other program, or set a different port in config.json.\n');
      process.exit(1);
    }
    throw err;
  }

  if (generated) {
    console.log('\n  First run - an account was created for you:');
    console.log('    username:  admin');
    console.log(`    password:  ${generated}`);
    console.log('  Write it down. Change it any time with: npm run setup');
  }
  net.printBanner({
    httpPort: handle.port,
    httpsPort: handle.httpsPort,
    library: handle.LIBRARY,
    ffmpegReady: ffmpeg.tools().available,
  });

  return handle;
}

if (require.main === module) main();

module.exports = { main, config };
