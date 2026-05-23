#!/usr/bin/env node
'use strict';

const [,, command, ...args] = process.argv;

const commands = {
  init:         () => require('../src/init')(),
  log:          () => require('../src/log')(args[0]),
  search:       () => require('../src/search')(args.join(' ')),
  context:      () => require('../src/context')(),
  eject:        () => require('../src/eject')(),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
};

if (!command || !(command in commands)) {
  console.log(`pebbl — local project memory

Usage:
  pebbl init                  Set up .pebbl/ in current project
  pebbl log "[message]"       Record a decision or note
  pebbl search "[query]"      Semantic + keyword search over memory
  pebbl context               Last 5 entries for pasting into agent prompts
  pebbl eject                 Remove pebbl config from this project
  pebbl log-commit            (called by git post-commit hook)
`);
  process.exit(command ? 1 : 0);
}

commands[command]();
