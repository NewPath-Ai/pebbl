'use strict';

const SPEC_PATTERN = /\b(default|threshold|weight|score\b|blend|config|param|formula)\b.{0,20}\d+\.?\d*/i;
const RATIONALE_PATTERN = /\b(because|so that|to prevent|the problem is|since|so \w+ would|why)\b/i;

function isThinEntry(message) {
  if (!message) return false;
  return SPEC_PATTERN.test(message) && !RATIONALE_PATTERN.test(message);
}

module.exports = { isThinEntry };
