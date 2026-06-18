#!/usr/bin/env node
'use strict';

const help = require('../src/help');

const [,, command, ...args] = process.argv;

const wantsHelp = (a) => a.includes('--help') || a.includes('-h');

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
  check:        () => require('../src/check')(args),
  'scan-commits': () => require('../src/scan-commits')(args),
  'log-commit': () => require('../src/log-commit')(args[0], args[1], args[2]),
  'migrate-to-events': () => require('../src/migrate-to-events')(args),
};

if (!command || command === '--help' || command === '-h') {
  help.printToplevel();
  process.exit(0);
}

if (command === 'help') {
  if (!args[0]) { help.printToplevel(); process.exit(0); }
  if (args[0] in commands) { help.printSubcommand(args[0]); process.exit(0); }
  help.printTopic(args[0]);
  process.exit(0);
}

if (wantsHelp(args)) {
  if (command in commands) { help.printSubcommand(command); process.exit(0); }
  help.printToplevel();
  process.exit(0);
}

if (!(command in commands)) {
  console.error(`pebbl: unknown command '${command}'\n`);
  help.printToplevel();
  process.exit(1);
}

commands[command]();
