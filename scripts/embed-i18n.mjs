#!/usr/bin/env node
// Embeds the translations from i18n/*.json into index.html.
//
//   node scripts/embed-i18n.mjs    (or: npm run build)
//
// The files in i18n/ are the only source of the texts. The plugin iframe is not
// served any other files, so the texts are additionally inlined in index.html
// between the /*I18N-START*/ and /*I18N-END*/ markers. Run this after changing a
// translation; `npm run pack` runs it automatically.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const langs = manifest.i18n?.languages ?? ['en'];
if (!langs.includes('en')) fail('manifest.json i18n.languages must include "en"');

const dicts = {};
for (const lang of langs) {
  try {
    dicts[lang] = JSON.parse(readFileSync(join(ROOT, 'i18n', `${lang}.json`), 'utf8'));
  } catch (e) {
    fail(`i18n/${lang}.json is missing or not valid JSON: ${e.message}`);
  }
}

// Every language must have exactly the keys of the English file
const keys = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
const enKeys = new Set(keys(dicts.en));
for (const lang of langs) {
  const own = new Set(keys(dicts[lang]));
  const missing = [...enKeys].filter((k) => !own.has(k));
  const extra = [...own].filter((k) => !enKeys.has(k));
  if (missing.length || extra.length) {
    fail(`i18n/${lang}.json: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
}

const htmlPath = join(ROOT, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const blob = JSON.stringify(dicts).replaceAll('</', '<\\/');
const marker = /\/\*I18N-START\*\/[\s\S]*?\/\*I18N-END\*\//;
if (!marker.test(html)) fail('I18N markers not found in index.html');
const next = html.replace(marker, () => `/*I18N-START*/const I18N=${blob};/*I18N-END*/`);
writeFileSync(htmlPath, next);

console.log(`✓ index.html: embedded ${langs.join(', ')} (${enKeys.size} keys)${next === html ? ', unchanged' : ''}`);
