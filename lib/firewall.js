'use strict';

/**
 * Letting other devices on the network actually reach this machine.
 *
 * On Windows the app can be running perfectly and still be unreachable from a
 * phone, because the firewall silently drops the connection. It is the single
 * most common reason "it works on this laptop but my iPhone cannot see it",
 * and it is invisible: nothing errors, the phone just times out.
 *
 * Adding a rule needs administrator rights, which the app does not have and
 * should not ask for at launch. So this is offered once, during first-run
 * setup, as a button the user presses — which raises the UAC prompt as their
 * own deliberate action rather than something that appears unbidden.
 *
 * macOS prompts by itself the first time something listens, and ordinary
 * Linux desktops do not firewall inbound LAN traffic by default, so both are
 * a no-op here rather than a half-measure.
 */

const { spawnSync } = require('child_process');

const RULE_NAME = 'LANShare';

/** Whether this platform has something worth offering to configure. */
function isSupported(platform = process.platform) {
  return platform === 'win32';
}

function run(command, args) {
  try {
    return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } catch (err) {
    return { status: 1, stderr: err.message, stdout: '' };
  }
}

/**
 * Is a rule already in place for this executable?
 *
 * Matched on the rule name, since that is what we create. A rule someone
 * added by hand under a different name will not be seen — the cost is
 * offering to add one that is not needed, which is harmless.
 */
function status({ platform = process.platform, execPath = process.execPath } = {}) {
  if (!isSupported(platform)) {
    return { supported: false, present: false, reason: 'This platform does not need a rule' };
  }

  const res = run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`]);
  const output = `${res.stdout || ''}`;
  const present = res.status === 0 && /Enabled:\s*Yes/i.test(output);

  return {
    supported: true,
    present,
    // Reported so the UI can say which program the rule would cover — a
    // packaged install and a dev run are different executables, and a rule
    // for one does nothing for the other.
    program: execPath,
  };
}

/**
 * The command that adds the rule.
 *
 * Split out from running it so it can be tested, and so the UI can show
 * exactly what will be run as administrator. Asking someone to approve a UAC
 * prompt without being able to see what it does is not a fair ask.
 */
function buildCommand({ execPath = process.execPath, ports = [] } = {}) {
  // Scoped to private networks: a home or office network you have told Windows
  // you trust. Never public — a library or café should not be able to reach
  // your photo library because you once ticked a box.
  const rules = [
    ['advfirewall', 'firewall', 'add', 'rule',
      `name=${RULE_NAME}`, 'dir=in', 'action=allow',
      `program=${execPath}`, 'enable=yes', 'profile=private'],
  ];

  for (const port of ports.filter(Boolean)) {
    rules.push(['advfirewall', 'firewall', 'add', 'rule',
      `name=${RULE_NAME} (port ${port})`, 'dir=in', 'action=allow',
      'protocol=TCP', `localport=${port}`, 'enable=yes', 'profile=private']);
  }
  return rules;
}

/**
 * Add the rule, raising a UAC prompt.
 *
 * Returns rather than throws on refusal: declining the prompt is a legitimate
 * choice, and the app has to keep working — it just will not be reachable
 * from other devices until the rule exists or the user allows it when Windows
 * next asks.
 */
function allow({ execPath = process.execPath, ports = [], platform = process.platform } = {}) {
  if (!isSupported(platform)) {
    return { ok: true, changed: false, reason: 'No rule is needed on this platform' };
  }

  // One elevated shell for every rule, so there is a single UAC prompt rather
  // than one per rule — three prompts in a row reads as something going wrong.
  const script = buildCommand({ execPath, ports })
    .map((args) => `netsh ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`)
    .join('; ');

  const elevated = run('powershell', ['-NoProfile', '-Command',
    'Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden '
    + `-ArgumentList '-NoProfile','-Command',${JSON.stringify(script)}`]);

  if (elevated.status !== 0) {
    return {
      ok: false,
      changed: false,
      reason: 'Windows did not allow the change. You can add the rule yourself, or allow '
        + 'LANShare when Windows next asks.',
    };
  }
  return { ok: true, changed: true };
}

module.exports = { RULE_NAME, isSupported, status, allow, buildCommand };
