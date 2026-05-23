'use strict';
const fs = require('fs');
const path = require('path');

function parseYaml(content) {
  const lines = content.split('\n');
  const result = { rules: [] };
  let currentBlock = null;
  let currentItem = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;

    if (indent === 0 && !trimmed.startsWith('-')) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentBlock = trimmed.slice(0, colonIdx);
        result[currentBlock] = result[currentBlock] || {};
      }
      continue;
    }

    if (indent === 2 && trimmed.startsWith('-') && trimmed.includes(':')) {
      currentItem = {};
      result.rules.push(currentItem);
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentItem[trimmed.slice(2, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }

    if (indent === 4 && currentItem) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        currentItem[trimmed.slice(0, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }

    if (indent === 2 && currentBlock) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        result[currentBlock][trimmed.slice(0, colonIdx).trim()] = parseValue(trimmed.slice(colonIdx + 1).trim());
      }
      continue;
    }
  }

  return result;
}

function parseValue(raw) {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

function loadRubric(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) return [];

  const raw = fs.readFileSync(rubricPath, 'utf8');
  const parsed = parseYaml(raw);
  const rules = (parsed.rules || []).map(r => ({
    pattern: r.pattern ? new RegExp(r.pattern, 'i') : null,
    category: r.category || null,
    tier: r.tier || null,
  })).filter(r => r.pattern && r.category);

  return rules;
}

function loadConfig(pebblDir) {
  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) return null;

  const raw = fs.readFileSync(configPath, 'utf8');
  return parseYaml(raw);
}

function classifyEntry(rules, message) {
  for (const rule of rules) {
    if (rule.pattern.test(message)) {
      return { category: rule.category, tier: rule.tier };
    }
  }
  return null;
}

module.exports = { loadRubric, loadConfig, classifyEntry, parseYaml };

const DEFAULT_RUBRIC = `# Pebbl classification rubric — edit to tune auto-tagging
# Rules are evaluated top-to-bottom; first match wins.
# Pattern is matched case-insensitively against the entry message.

rules:
  - pattern: "\\[session\\]"
    category: uncategorized
    tier: fleeting

  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint"
    category: decision
    tier: signal

  - pattern: "module|component|boundary|owns|ownership|depends on|architecture"
    category: structure
    tier: signal

  - pattern: "convention|pattern|standard|always|never|rule:|style"
    category: pattern
    tier: signal

  - pattern: "schema|model|table|column|migration|data flow|storage"
    category: data
    tier: detail

  - pattern: "api|endpoint|contract|integration|webhook|external"
    category: integration
    tier: detail

  - pattern: "perf|latency|SLA|security|posture|target|benchmark"
    category: quality
    tier: detail
`;

const DEFAULT_CONFIG = `compaction:
  threshold: 10
  fleeting_retention: 30
`;

function ensureProjectFiles(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
  }

  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
  }
}

module.exports.DEFAULT_RUBRIC = DEFAULT_RUBRIC;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.ensureProjectFiles = ensureProjectFiles;
