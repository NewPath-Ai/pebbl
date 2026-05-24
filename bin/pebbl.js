#!/usr/bin/env node
'use strict';

const [,, command, ...args] = process.argv;

const commands = {
  init:         () => require('../src/init')(),
  log:          () => require('../src/log')(args),
  search:       () => require('../src/search')(args),
  context:      () => require('../src/context')(args),
  compact:      () => require('../src/compact')(args),
  upgrade:      () => require('../src/upgrade')(),
  eject:        () => require('../src/eject')(),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
};

if (!command || !(command in commands)) {
  console.log(`pebbl — local project memory

Usage:
  pebbl init                  Set up .pebbl/ in current project
  pebbl log "[message]"       Record a decision or note
    --cat <category>          decision|structure|pattern|data|integration|quality
    --topic <topic>           Free-form topic (e.g. "auth,api")
    --tier <tier>             signal|detail|fleeting
    --source <source>         human|agent|hook (default: human)
    --relates <id>            Related entry ID
    --corrects <id>           Entry this corrects

    Examples:
      pebbl log "threshold is 0.5 because Professional Services touches everything at 0.2"
      pebbl log "threshold is 0.5, weight is 0.6"   ← missing why, will warn

  pebbl search "[query]"      Semantic + keyword search over memory
    --cat <category>          Filter by category
    --topic <topic>           Filter by topic
  pebbl context               Recent entries with rationale warnings & git context
    --cat <category>          Filter by category
    --topic <topic>           Filter by topic
  pebbl compact               Compact entries on a topic
    --preview                 Show groups ready for compaction
    --execute                 Execute compaction
    --resolve <id:action,...> Resolve ambiguous entries
  pebbl upgrade               Update .pebbl/ to the latest version
  pebbl eject                 Remove pebbl config from this project
  pebbl log-commit            (called by git post-commit hook)
`);
  process.exit(command ? 1 : 0);
}

commands[command]();
