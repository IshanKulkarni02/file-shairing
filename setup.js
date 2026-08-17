'use strict';

/**
 * Interactive account setup: `npm run setup`
 * Sets or replaces the username and password used to sign in.
 */

const readline = require('readline');
const configLib = require('./lib/config');
const sessions = require('./lib/sessions');

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** Read a line without echoing it, so the password never sits on screen. */
function askHidden(rl, question) {
  return new Promise((resolve) => {
    const onKeypress = (char) => {
      // Redraw the prompt with no characters after it.
      if (char === '\n' || char === '\r' || char === '') return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(question);
    };
    process.stdin.on('data', onKeypress);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onKeypress);
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const existing = configLib.load();

  console.log('\n  LANShare account setup\n');
  if (existing && existing.users.length) {
    console.log(`  Current account: ${existing.users.map((u) => u.username).join(', ')}\n`);
  }

  const suggested = existing?.users?.[0]?.username || 'admin';
  const username = (await ask(rl, `  Username [${suggested}]: `)) || suggested;

  let password = await askHidden(rl, '  Password (leave blank to generate one): ');
  let wasGenerated = false;

  if (!password) {
    password = configLib.randomPassword();
    wasGenerated = true;
  } else {
    if (password.length < 4) {
      console.log('\n  That password is too short. Use at least 4 characters.\n');
      rl.close();
      process.exitCode = 1;
      return;
    }
    const again = await askHidden(rl, '  Repeat password: ');
    if (again !== password) {
      console.log('\n  Those did not match. Nothing was changed.\n');
      rl.close();
      process.exitCode = 1;
      return;
    }
  }

  configLib.setUser(username, password);
  // This command is the documented recovery path for a forgotten or
  // compromised password, so leaving already-signed-in devices signed in
  // would defeat the point of running it: a stolen session cookie is signed
  // with the server secret, not the password, and would otherwise keep
  // working for the full sessionDays no matter what is typed here.
  sessions.revokeAllForUser(username);
  rl.close();

  console.log('\n  Saved.\n');
  console.log(`    username:  ${username}`);
  if (wasGenerated) console.log(`    password:  ${password}   (generated — write it down)`);
  console.log('\n  Start the server with:  npm start\n');
}

main().catch((err) => {
  console.error(`\n  Setup failed: ${err.message}\n`);
  process.exit(1);
});
