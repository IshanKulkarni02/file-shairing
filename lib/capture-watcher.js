'use strict';

/**
 * Noticing a capture device the moment it is plugged in.
 *
 * Same polling discipline lib/sync-watcher.js already uses for a drive with
 * a configured sync target — present/arrived tracked by volume id, primed
 * on the first tick so whatever is already plugged in at startup is never
 * treated as a fresh arrival — applied instead to *any* volume nobody has
 * configured anything for at all. Every genuine arrival is checked, in
 * order; lib/capture-device.js is what actually decides whether each one is
 * worth telling anybody about.
 */

const volumes = require('./volumes.js');
const capture = require('./capture-device.js');

// Shorter than sync-watcher's 15s: someone who just plugged in a card is
// usually standing right there, waiting to be asked.
const DEFAULT_INTERVAL_MS = 5000;

class CaptureWatcher {
  /**
   * @param {object} deps
   * @param {() => object} deps.getConfig
   * @param {() => import('./index-db').IndexDb | null} deps.getIndexDb
   * @param {() => string | null} [deps.getLibraryVolumeId]
   * @param {(arrival: {volume: object, plan: object}) => void} [deps.onDetected]
   * @param {(msg: string) => void} [deps.log]
   * @param {number} [deps.intervalMs]
   */
  constructor({
    getConfig, getIndexDb, getLibraryVolumeId = () => null, onDetected = null, log = null,
    intervalMs = DEFAULT_INTERVAL_MS,
  }) {
    this.getConfig = getConfig;
    this.getIndexDb = getIndexDb;
    this.getLibraryVolumeId = getLibraryVolumeId;
    this.onDetected = onDetected;
    this.log = log || (() => {});
    this.intervalMs = intervalMs;

    this.timer = null;
    /** Volume ids seen present on the previous tick. */
    this.present = new Set();
    this.primed = false;
  }

  start() {
    if (this.timer) return;
    this.tick({ primeOnly: true }).catch((err) => this.log(`capture watcher: ${err.message}`));
    this.timer = setInterval(
      () => this.tick().catch((err) => this.log(`capture watcher: ${err.message}`)),
      this.intervalMs,
    );
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick({ primeOnly = false } = {}) {
    const config = this.getConfig();
    const indexDb = this.getIndexDb?.();
    if (!config || !indexDb) return;

    const all = volumes.list({ fresh: true }).filter((v) => v.id);
    const arrived = all.filter((v) => !this.present.has(v.id));
    this.present = new Set(all.map((v) => v.id));

    if (primeOnly || !this.primed) {
      this.primed = true;
      return;
    }
    if (!arrived.length) return;

    for (const volume of arrived) {
      let plan = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        plan = await capture.checkVolume({
          volume, config, indexDb, libraryVolumeId: this.getLibraryVolumeId(),
        });
      } catch (err) {
        this.log(`capture watcher: could not check "${volume.label}" — ${err.message}`);
        continue;
      }
      if (plan && plan.candidates.length) {
        this.log(`capture: "${volume.label}" looks like a capture device — ${plan.candidates.length} new file(s)`);
        this.onDetected?.({ volume, plan });
      }
    }
  }
}

module.exports = { CaptureWatcher, DEFAULT_INTERVAL_MS };
