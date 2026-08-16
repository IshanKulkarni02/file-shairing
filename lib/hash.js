'use strict';

/**
 * A file's content hash — used to recognise "the same file" independent of
 * its name or where it sits: the same photo on two machines, a duplicate
 * sitting in two albums, or a card that has already been imported.
 *
 * Streamed rather than read whole, so hashing a multi-gigabyte video costs
 * constant memory rather than its own size — the same discipline every other
 * file-reading path in this app already follows.
 */

const crypto = require('crypto');
const fs = require('fs');

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

module.exports = { hashFile };
