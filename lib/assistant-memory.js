'use strict';

/**
 * Retrieval over lib/index-db.js's assistant_memory table — the "accepted-
 * rule memory" and "correction memory" plan.md describes: retrieval-
 * augmented prompting over one person's own history, not fine-tuning.
 * Nothing here trains anything; it just picks which past examples are
 * worth showing the model before it drafts again.
 *
 * Stored and retrieved as the corrected PAIR — the instruction, and the
 * rule actually wanted — never as "the model said X and X was wrong."
 * Showing a model its own bad output tends to anchor it toward repeating
 * that output; showing the right answer for that instruction carries the
 * same information without the pull.
 *
 * Deliberately keyword-overlap scoring, not a semantic embedding search:
 * this project already has one embedding pipeline (lib/clip.js, for
 * images), and standing up a second, unrelated one just to rank a few
 * dozen short instruction strings is more machinery than the problem
 * needs. Simple, fast, fully local, and easy to reason about beats a
 * second model dependency here.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'my', 'into', 'all', 'me', 'is', 'are', 'this', 'that',
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function overlapScore(tokensA, tokensB) {
  const setB = new Set(tokensB);
  return tokensA.filter((t) => setB.has(t)).length;
}

/**
 * The closest few examples to `instruction`. Corrections score slightly
 * higher than an ordinary acceptance at equal keyword overlap — a stronger
 * signal deserves a slight edge — and the single most recent correction
 * always makes the cut regardless of topic, per plan.md: "the fastest way
 * to stop a wrong pattern repeating," not something that should wait for a
 * keyword match before it's shown again.
 */
function closestExamples(db, instruction, { limit = 3, recentCorrectionWindow = 1 } = {}) {
  const all = db.allMemory();
  if (!all.length) return [];

  const queryTokens = tokenize(instruction);
  const picked = [];
  const pickedIds = new Set();

  const recentCorrections = all
    .filter((e) => e.isCorrection)
    .slice(0, recentCorrectionWindow); // allMemory() is already newest-first
  for (const entry of recentCorrections) {
    if (picked.length >= limit) break;
    picked.push(entry);
    pickedIds.add(entry.id);
  }

  const scored = all
    .filter((entry) => !pickedIds.has(entry.id))
    .map((entry) => ({
      entry,
      score: overlapScore(queryTokens, tokenize(entry.instruction)) + (entry.isCorrection ? 0.5 : 0),
    }))
    .sort((a, b) => b.score - a.score || Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt));

  for (const { entry, score } of scored) {
    if (picked.length >= limit) break;
    if (score <= 0) break; // no keyword overlap at all — stop rather than padding with unrelated history
    picked.push(entry);
    pickedIds.add(entry.id);
  }

  return picked;
}

module.exports = { tokenize, overlapScore, closestExamples };
