'use strict';

const KNOWN_FLAGS = new Set([
  'cat', 'topic', 'source', 'tier', 'scope',
  'relates', 'corrects', 'preview', 'execute', 'resolve',
  'done', 'todo', 'blocked', 'latest', 'list', 'close',
  'show', 'generate',
]);

const BOOLEAN_FLAGS = new Set(['preview', 'execute', 'latest', 'list', 'close', 'show', 'generate']);

function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--') && arg.length > 2) {
      const key = arg.slice(2);

      if (!KNOWN_FLAGS.has(key)) {
        positional.push(arg);
        continue;
      }

      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }

      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

module.exports = { parseArgs };
