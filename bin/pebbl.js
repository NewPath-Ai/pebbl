#!/usr/bin/env node
'use strict';

const [,, command, ...args] = process.argv;

const commands = {
  init:        () => require('../src/init')(),
  log:         () => require('../src/log')(args[0]),
  search:      () => require('../src/search')(args.join(' ')),
  context:     () => require('../src/context')(),
  'log-commit':() => require('../src/log-commit')(args[0], args[1], args[2]),
};

if (!command || !(command in commands)) {
  console.log(`pebbl — local project memory

Usage:
  pebbl init                  Set up .mem/ in current project
  pebbl log "[message]"       Record a decision or note
  pebbl search "[query]"      Semantic + keyword search over memory
  pebbl context               Last 5 entries for pasting into agent prompts
  pebbl log-commit            (called by git post-commit hook)
`);
  process.exit(command ? 1 : 0);
}

commands[command]();
