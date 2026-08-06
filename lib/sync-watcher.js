'use strict';

/**
 * Starting a sync when its drive appears.
 *
 * Drive arrival is detected by polling for the volume id rather than by
 * listening for device events. Polling is duller, but it behaves identically
 * on Windows, macOS and Linux, survives the app being asleep when the drive
 * was plugged in, and has no platform-specific failure mode to debug on
 * hardware I cannot test on.
 *
 * The rules that matter here are all about not doing the wrong thing twice:
 *
 *   - A drive is only acted on when it goes from **absent to present**. A
 *     drive that has been plugged in the whole time is not an arrival, or
 *     every poll would start another sync.
 *   - One run per target at a time, tracked here rather than trusted to
 *     timing.
 *   - A run that fails does not retry on the next tick. Something is wrong
 *     with that drive, and hammering it every 15 seconds helps nobody; the
 *     next genuine replug tries again.
 */

const volumes = require('./volumes.js');
const syncTargets = require('./sync-targets.js');
const syncEngine = require('./sync.js');

const DEFAULT_INTERVAL_MS = 15000;

class SyncWatcher {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig      current config, read fresh each tick
   * @param {() => string} deps.getLibrary     current library path
   * @param {(config: object) => void} [deps.save]  persist config after a run
   * @param {() => void} [deps.onChange]       fired when a run starts or ends
   * @param {(msg: string) => void} [deps.log]
   * @param {number} [deps.intervalMs]
   */
  constructor({ getConfig, getLibrary, save = null, onChange = null, log = null, intervalMs = DEFAULT_INTERVAL_MS }) {
    this.getConfig = getConfig;
    this.getLibrary = getLibrary;
    this.save = save;
    this.onChange = onChange;
    this.log = log || (() => {});
    this.intervalMs = intervalMs;

    this.timer = null;
    /** Volume ids seen present on the previous tick. */
    this.present = new Set();
    /** Target ids currently running. */
    this.running = new Set();
    /** Target ids whose last automatic attempt failed; cleared on a replug. */
    this.failed = new Set();
    /** Set on the first tick so a drive already plugged in is not an arrival. */
    this.primed = false;
  }

  start() {
    if (this.timer) return;
    // The first tick only records what is already connected. Treating the
    // state at startup as a set of arrivals would sync every drive every time
    // the app opens, which is not what "when I plug it in" means.
    this.tick({ primeOnly: true }).catch((err) => this.log(`sync watcher: ${err.message}`));
    this.timer = setInterval(
      () => this.tick().catch((err) => this.log(`sync watcher: ${err.message}`)),
      this.intervalMs,
    );
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Target ids running right now, for the UI. */
  runningIds() {
    return [...this.running];
  }

  async tick({ primeOnly = false } = {}) {
    const config = this.getConfig();
    if (!config) return;

    const attached = new Set(
      volumes.list({ fresh: true }).filter((v) => v.id).map((v) => v.id),
    );

    const arrived = new Set();
    for (const id of attached) if (!this.present.has(id)) arrived.add(id);

    // A drive that went away may come back with a different letter, and a
    // previous failure should not outlive the replug that might fix it.
    for (const id of this.present) {
      if (!attached.has(id)) this.forgetFailuresFor(config, id);
    }

    this.present = attached;

    if (primeOnly || !this.primed) {
      this.primed = true;
      return;
    }
    if (!arrived.size) return;

    // Which registered drives are the ones that just turned up.
    const arrivedLocations = new Set(
      (config.locations || [])
        .filter((location) => arrived.has(location.volumeId))
        .map((location) => location.id),
    );
    if (!arrivedLocations.size) return;

    for (const target of config.syncTargets || []) {
      if (!target.runOnConnect) continue;
      if (!arrivedLocations.has(target.locationId)) continue;
      if (this.running.has(target.id) || this.failed.has(target.id)) continue;

      await this.runTarget(target.id, target.label);
    }
  }

  forgetFailuresFor(config, volumeId) {
    for (const location of config.locations || []) {
      if (location.volumeId !== volumeId) continue;
      for (const target of config.syncTargets || []) {
        if (target.locationId === location.id) this.failed.delete(target.id);
      }
    }
  }

  async runTarget(id, label) {
    const config = this.getConfig();
    this.running.add(id);
    this.onChange?.();
    this.log(`sync: "${label}" started because its drive was connected`);

    try {
      const resolved = syncTargets.resolveForRun(config, this.getLibrary(), id);
      const report = await syncEngine.run({
        library: this.getLibrary(),
        sourceDir: resolved.sourceDir,
        targetDir: resolved.targetDir,
        driveRoot: resolved.driveRoot,
        targetId: resolved.targetId,
        policy: resolved.policy,
        conflictLabel: resolved.conflictLabel,
      });

      syncTargets.recordRun(config, id, report);
      // Without this the "last synced" line is right until the app restarts
      // and then silently reverts to "never run".
      try { this.save?.(config); } catch (err) { this.log(`sync: could not save the result — ${err.message}`); }

      this.log(report.stoppedEarly
        ? `sync: "${label}" stopped early — the drive went away`
        : `sync: "${label}" finished (${report.planned.total} changes, ${report.failed.length} failed)`);
      return report;
    } catch (err) {
      // Not retried until the drive is unplugged and reconnected. Whatever is
      // wrong will still be wrong in fifteen seconds.
      this.failed.add(id);
      this.log(`sync: "${label}" could not run — ${err.message}`);
      return null;
    } finally {
      this.running.delete(id);
      this.onChange?.();
    }
  }
}

module.exports = { SyncWatcher, DEFAULT_INTERVAL_MS };
