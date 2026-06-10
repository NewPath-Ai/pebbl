'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('./args');
const { requirePebblDir } = require('./find-pebbl');
const { loadConfig, ensureProjectFiles } = require('./rubric');

const VALID_FIELDS = {
  maturity: ['prototype', 'production', 'enterprise'],
  security: ['relaxed', 'standard', 'strict'],
  test_expectation: ['smoke', 'coverage', 'comprehensive'],
};

function readPosture(pebblDir) {
  const config = loadConfig(pebblDir) || {};
  return config.posture || null;
}

function formatPosture(posture) {
  if (!posture) return '(no posture set)';
  const lines = [];
  if (posture.maturity) lines.push(`  maturity:         ${posture.maturity}`);
  if (posture.security) lines.push(`  security:         ${posture.security}`);
  if (posture.test_expectation) lines.push(`  test_expectation: ${posture.test_expectation}`);
  if (posture.notes) lines.push(`  notes:            ${posture.notes}`);
  if (lines.length === 0) return '(no posture set)';
  return lines.join('\n');
}

function setPostureField(pebblDir, key, value) {
  if (key !== 'notes' && VALID_FIELDS[key]) {
    if (!VALID_FIELDS[key].includes(value)) {
      console.error(`Invalid value "${value}" for ${key}. Valid: ${VALID_FIELDS[key].join(', ')}`);
      process.exit(1);
    }
  }
  if (!VALID_FIELDS[key] && key !== 'notes') {
    console.error(`Unknown posture field "${key}". Valid: ${Object.keys(VALID_FIELDS).join(', ')}, notes`);
    process.exit(1);
  }

  const configPath = path.join(pebblDir, 'config.yml');
  let content = '';
  if (fs.existsSync(configPath)) {
    content = fs.readFileSync(configPath, 'utf8');
  }

  if (!content.includes('posture:')) {
    content += '\nposture:\n';
  }

  const lines = content.split('\n');
  const out = [];
  let inPosture = false;
  let fieldWritten = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'posture:') {
      inPosture = true;
      out.push(line);
      continue;
    }
    if (inPosture && trimmed && !trimmed.startsWith('#') && !line.startsWith(' ') && !line.startsWith('\t')) {
      inPosture = false;
    }
    if (inPosture && trimmed.startsWith(key + ':')) {
      out.push(`  ${key}: ${value}`);
      fieldWritten = true;
      continue;
    }
    out.push(line);
  }

  if (!fieldWritten) {
    const postureIdx = out.findIndex(l => l.trim() === 'posture:');
    if (postureIdx !== -1) {
      out.splice(postureIdx + 1, 0, `  ${key}: ${value}`);
    }
  }

  fs.writeFileSync(configPath, out.join('\n'));
}

module.exports = function posture(args) {
  const { flags, positional } = parseArgs(args);
  const pebblDir = requirePebblDir();
  ensureProjectFiles(pebblDir);

  if (flags.set) {
    const eqIdx = flags.set.indexOf('=');
    if (eqIdx === -1) {
      console.error('Usage: pebbl posture --set key=value');
      process.exit(1);
    }
    const key = flags.set.slice(0, eqIdx);
    const value = flags.set.slice(eqIdx + 1);
    setPostureField(pebblDir, key, value);
    console.log(`posture.${key} = ${value}`);
    return;
  }

  const p = readPosture(pebblDir);
  console.log('--- POSTURE ---');
  console.log(formatPosture(p));
  console.log('---');
};

module.exports.readPosture = readPosture;
module.exports.formatPosture = formatPosture;
module.exports.setPostureField = setPostureField;
module.exports.VALID_FIELDS = VALID_FIELDS;
