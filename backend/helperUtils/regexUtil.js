/**
 * Regex safety helpers for user-supplied search input.
 *
 * Passing raw user input into `$regex` / `new RegExp()` lets an attacker inject
 * regex metacharacters — at best wrong matches, at worst catastrophic
 * backtracking (ReDoS). `escapeRegExp` neutralizes metacharacters so the input
 * is treated as a literal substring; `safeKeyword` also caps length.
 */

/** Escape all regex metacharacters in a string. */
const escapeRegExp = (str = "") =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalize a user keyword for safe use in a $regex query: trimmed, length-capped
 * (defangs pathological inputs), and metacharacter-escaped (literal match).
 * @param {string} keyword
 * @param {number} [maxLen=100]
 * @returns {string} safe, escaped substring (empty string if no input)
 */
const safeKeyword = (keyword, maxLen = 100) =>
  escapeRegExp(String(keyword ?? "").trim().slice(0, maxLen));

module.exports = { escapeRegExp, safeKeyword };
