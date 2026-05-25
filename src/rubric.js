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
  - pattern: "^\\[session\\]"
    category: uncategorized
    tier: fleeting

  - pattern: "chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated"
    category: decision
    tier: component

  - pattern: "module|component|boundary|owns|ownership|depends on|architecture"
    category: structure
    tier: component

  - pattern: "convention|pattern|standard|always|never|rule:|style"
    category: pattern
    tier: component

  - pattern: "schema|model|table|column|migration|data flow|storage"
    category: data
    tier: detail

  - pattern: "api|endpoint|contract|integration|webhook|external"
    category: integration
    tier: detail

  - pattern: "perf|latency|SLA|security|posture|target|benchmark"
    category: quality
    tier: detail

  - pattern: "\\b(default|threshold|weight|score\\b|blend|config|param|formula)\\b.{0,20}\\d+\\.?\\d*"
    category: decision
    tier: detail
`;

const DEFAULT_CONFIG = `compaction:
  threshold: 10
  fleeting_retention: 30
`;

function migrateRubric(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) return;

  let content = fs.readFileSync(rubricPath, 'utf8');
  let sessionMigrated = false;
  let decisionMigrated = false;

  // v0.2.1: anchor [session] pattern to start of message.
  // Old pattern matched [session] mid-text, causing entries like
  // "the [session] token expires" to get fleeting tier.
  const oldPattern = /pattern:\s*["']\\?\[session\\?\]["']/;
  const anchoredPattern = /pattern:\s*["']\^\\?\[session\\?\]["']/;
  if (oldPattern.test(content) && !anchoredPattern.test(content)) {
    content = content.replace(oldPattern, (match) => {
      // Insert ^ anchor after the opening quote
      return match.replace(/["']\\?\[/, (m) => m[0] + '^' + m.slice(1));
    });
    sessionMigrated = true;
  }

  // v0.2.2: expand decision keywords.
  // Old pattern lacked common agent verbs like switched, adopted, rejected, etc.
  const oldDecision = 'chose|decided|decision|picked|went with|trade-?off|constraint';
  const expandedDecision = 'chose|decided|decision|picked|went with|trade-?off|constraint|switched|replaced|changed to|adopted|rejected|dropped|reverted|migrated';
  if (content.includes(oldDecision) && !content.includes('switched|replaced|changed to|adopted')) {
    content = content.replace(oldDecision, expandedDecision);
    decisionMigrated = true;
  }

  // v0.3: rename tier: signal → tier: component
  let signalMigrated = false;
  if (content.includes('tier: signal') && !content.includes('tier: component')) {
    content = content.replace(/tier:\s*signal/g, 'tier: component');
    signalMigrated = true;
    console.error('pebbl: migrated rubric.yml (signal → component tier)');
  }

  if (sessionMigrated) {
    console.error('pebbl: migrated rubric.yml (anchored [session] pattern)');
  }
  if (decisionMigrated) {
    console.error('pebbl: migrated rubric.yml (expanded decision keywords)');
  }
  if (sessionMigrated || decisionMigrated || signalMigrated) {
    fs.writeFileSync(rubricPath, content);
  }
}

function ensureProjectFiles(pebblDir) {
  const rubricPath = path.join(pebblDir, 'rubric.yml');
  if (!fs.existsSync(rubricPath)) {
    fs.writeFileSync(rubricPath, DEFAULT_RUBRIC);
  } else {
    migrateRubric(pebblDir);
  }

  const configPath = path.join(pebblDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_CONFIG);
  }
}

module.exports.DEFAULT_RUBRIC = DEFAULT_RUBRIC;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.ensureProjectFiles = ensureProjectFiles;
