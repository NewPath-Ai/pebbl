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
  handoff:      () => require('../src/handoff')(args),
  narrative:    () => require('../src/narrative')(args),
  feedback:     () => require('../src/feedback')(args),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
};

if (!command || !(command in commands)) {
  console.log(`pebbl — local project memory

Usage:
  pebbl init                  Set up .pebbl/ in current project
  pebbl log "[message]"       Record a decision or note
    --cat <category>          decision|structure|pattern|data|integration|quality
    --topic <topic>           Free-form topic (e.g. "auth,api")
    --tier <tier>             foundation|component|detail|fleeting
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
  pebbl handoff "[summary]"   Create a session handoff for the next agent
    --done <items>            Semicolon-separated completed items
    --todo <items>            Semicolon-separated remaining items
    --blocked <items>         Semicolon-separated blockers
    --topic <topic>           Free-form topic (e.g. "auth,api")
    --source <source>         human|agent (default: agent)
    --latest                  Show the most recent handoff
    --list                    List recent handoffs
    --close                   Close the open handoff (promotes to foundation-tier log)
  pebbl narrative             View or set the project narrative
  pebbl narrative "..."       Set the narrative description
    --show                    Show the current narrative
    --generate                Guide on writing a narrative from foundation entries
  pebbl compact               Compact entries on a topic
    --preview                 Show groups ready for compaction
    --execute                 Execute compaction
    --resolve <id:action,...> Resolve ambiguous entries
  pebbl feedback "[message]"  Drop feedback about pebbl when it misbehaves here
    --list                    Review feedback recorded in this repo
  pebbl upgrade               Update .pebbl/ to the latest version
  pebbl eject                 Remove pebbl config from this project
  pebbl log-commit            (called by git post-commit hook)
`);
  process.exit(command ? 1 : 0);
}

commands[command]();
