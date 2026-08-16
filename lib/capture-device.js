'use strict';

/**
 * The policy layer in front of lib/import.js's mechanics: should a
 * newly-appeared volume actually be offered for import right now?
 *
 * Three reasons it might not be, checked cheapest-first:
 *   - it is not a capture device at all (no DCIM folder);
 *   - it is not a stranger's card — it is this install's own library drive,
 *     or a drive already tracked as a relocated album (Phase C) — so
 *     "importing from it" would not mean what it means for an actual card;
 *   - the person already said never for this specific card.
 *
 * "Never for this card" is remembered by the same stable volume id
 * Phase C already uses (survives a drive-letter change, a replug, a
 * different USB port), not by a path or a label — a label is not even
 * guaranteed unique between two cards from the same camera model.
 */

const importLib = require('./import');

function ensureDismissedList(config) {
  if (!Array.isArray(config.dismissedCaptureDevices)) config.dismissedCaptureDevices = [];
  return config.dismissedCaptureDevices;
}

function isDismissed(config, volumeId) {
  return Boolean(volumeId) && ensureDismissedList(config).includes(volumeId);
}

/** "Never for this card" — persisted so it survives a restart, not just this session. */
function dismiss(config, configLib, volumeId) {
  if (!volumeId) return;
  const list = ensureDismissedList(config);
  if (!list.includes(volumeId)) {
    list.push(volumeId);
    configLib.save(config);
  }
}

function undismiss(config, configLib, volumeId) {
  const list = ensureDismissedList(config);
  const index = list.indexOf(volumeId);
  if (index >= 0) {
    list.splice(index, 1);
    configLib.save(config);
  }
}

/**
 * True when this volume is something the app already manages on purpose —
 * the library's own drive, or a drive holding a relocated album — rather
 * than an unrelated card that happens to be plugged in. A sync target is
 * not checked separately: it always points at a location, and every
 * location already carries the volume id its drive was created on.
 */
function isKnownVolume({ config, volumeId, libraryVolumeId }) {
  if (!volumeId) return false;
  if (libraryVolumeId && libraryVolumeId === volumeId) return true;
  return (config.locations || []).some((loc) => loc.volumeId === volumeId);
}

/**
 * Should this volume be offered for import right now? Returns the plan
 * (see lib/import.js) if so, or null if not — for any of the three reasons
 * above. A null here is not an error state; it is the ordinary answer for
 * almost every volume the watcher will ever see (an ordinary USB drive, the
 * library's own disk, a card already dismissed).
 */
async function checkVolume({
  volume, config, indexDb, libraryVolumeId,
}) {
  if (isKnownVolume({ config, volumeId: volume.id, libraryVolumeId })) return null;
  if (isDismissed(config, volume.id)) return null;
  return importLib.planImport({ mountPoint: volume.mountPoint, indexDb });
}

module.exports = {
  ensureDismissedList, isDismissed, dismiss, undismiss, isKnownVolume, checkVolume,
};
