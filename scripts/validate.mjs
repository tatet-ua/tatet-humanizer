#!/usr/bin/env node
/**
 * Перевірки узгодженості пакета. Без залежностей.
 *
 *   node scripts/validate.mjs
 *
 * Код виходу 0 якщо все гаразд, 1 якщо є помилки.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => join(ROOT, ...s);
const read = f => readFileSync(p(f), 'utf8');

let errors = 0;
let warnings = 0;

const ok = m => console.log(`  ok    ${m}`);
const bad = m => { console.log(`  ПОМИЛКА ${m}`); errors++; };
const warn = m => { console.log(`  увага ${m}`); warnings++; };

function section(name) { console.log(`\n${name}`); }

// --- 1. Наявність файлів -----------------------------------------------
section('Структура');

const REQUIRED = [
  'SKILL.md',
  'references/symbols.md',
  'references/patterns.md',
  'README.md',
  'LICENSE',
  'AGENTS.md',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
];
for (const f of REQUIRED) {
  existsSync(p(f)) ? ok(f) : bad(`відсутній ${f}`);
}
if (errors) { console.log('\nБракує обовязкових файлів, далі не перевіряю.'); process.exit(1); }

// --- 2. Frontmatter ----------------------------------------------------
section('Frontmatter SKILL.md');

const skill = read('SKILL.md');
const fmMatch = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) {
  bad('frontmatter не знайдено або зіпсовано');
} else {
  const fm = fmMatch[1];
  for (const key of ['name', 'description', 'license']) {
    new RegExp(`^${key}:`, 'm').test(fm) ? ok(`поле ${key}`) : bad(`немає поля ${key}`);
  }
  /metadata:\s*[\s\S]*version:/.test(fm)
    ? ok('metadata.version')
    : bad('немає metadata.version');
  /^version:/m.test(fm) && warn('верхньорівневий version не портативний, тримайте під metadata');

  const nameV = fm.match(/^name:\s*(\S+)/m)?.[1];
  const plug = JSON.parse(read('.claude-plugin/plugin.json'));
  nameV === plug.name
    ? ok(`ім'я збігається з plugin.json (${nameV})`)
    : bad(`ім'я скіла "${nameV}" не збігається з plugin.json "${plug.name}"`);

  const skillV = fm.match(/version:\s*"?([\d.]+)"?/)?.[1];
  skillV === plug.version
    ? ok(`версія збігається (${skillV})`)
    : bad(`версія SKILL.md "${skillV}" не збігається з plugin.json "${plug.version}"`);
}

// --- 3. Маніфести ------------------------------------------------------
section('Маніфести');

let market;
try {
  market = JSON.parse(read('.claude-plugin/marketplace.json'));
  ok('marketplace.json валідний JSON');
} catch (e) {
  bad(`marketplace.json не парситься: ${e.message}`);
}
if (market) {
  const plug = JSON.parse(read('.claude-plugin/plugin.json'));
  const entry = market.plugins?.[0];
  entry?.name === plug.name
    ? ok('назва плагіна збігається в обох маніфестах')
    : bad(`marketplace.json описує "${entry?.name}", plugin.json "${plug.name}"`);
  entry?.source === './'
    ? ok('source вказує на корінь репозиторію')
    : warn(`source = "${entry?.source}", очікувалося "./" (SKILL.md має лежати в корені)`);
}

// --- 4. Мітки патернів -------------------------------------------------
section('Мітки патернів');

const patterns = read('references/patterns.md');
const marks = new Set([...patterns.matchAll(/\[h(\d+)\]/g)].map(m => +m[1]));
const missing = [];
for (let i = 1; i <= 33; i++) if (!marks.has(i)) missing.push(i);
missing.length === 0
  ? ok(`усі 33 мітки [h1]-[h33] на місці`)
  : bad(`бракує міток: ${missing.map(n => `h${n}`).join(', ')}`);

const extra = [...marks].filter(n => n > 33);
if (extra.length) warn(`мітки понад h33: ${extra.join(', ')} (для власних патернів беріть [tN])`);

for (const conflicted of [14, 19, 26]) {
  // шукаємо саме заголовок розділу, а не згадку в шапці файлу
  const at = patterns.indexOf(`### [h${conflicted}]`);
  if (at < 0) { bad(`[h${conflicted}] не має власного розділу`); continue; }
  const near = patterns.slice(at, at + 700);
  /замінено|адаптовано/.test(near)
    ? ok(`[h${conflicted}] позначений як замінений або адаптований`)
    : bad(`[h${conflicted}] має бути позначений: оригінальне правило не годиться для української`);
}

// --- 5. Три реалізації одного алгоритму --------------------------------
section('Узгодженість реалізацій');

// Символи записані по-різному: у PowerShell через `u{XXXX}, у JS через
// \uXXXX або літералами. Збираємо і те, і те, інакше порівняння бреше.
function isNoise(cp) {
  if (cp <= 0x7f) return true;                     // ASCII: це цілі заміни, а не спецсимволи
  if (cp >= 0x0400 && cp <= 0x04ff) return true;   // кирилиця з коментарів
  if (cp >= 0xd800 && cp <= 0xdfff) return true;   // сурогатні межі регулярок
  return false;
}
// Повертає { has(cp) }: одиничні коди плюс діапазони. Без діапазонів
// перевірка бреше, бо ☀-➿ покриває сотні символів одним записом.
function collectCodes(src) {
  const set = new Set();
  const ranges = [];

  const addRanges = (re, radix = 16) => {
    for (const m of src.matchAll(re)) {
      const a = parseInt(m[1], radix), b = parseInt(m[2], radix);
      if (a < b) ranges.push([a, b]);
    }
  };
  // \\+ бо в JS-джерелах escape буває записаний як \u або \\u
  addRanges(/\\+u\{?([0-9A-Fa-f]{4,5})\}?\s*-\s*\\+u\{?([0-9A-Fa-f]{4,5})\}?/g);
  addRanges(/`u\{([0-9A-Fa-f]{4,5})\}\s*-\s*`u\{([0-9A-Fa-f]{4,5})\}/g);

  for (const m of src.matchAll(/`u\{([0-9A-Fa-f]{4,5})\}/g)) set.add(parseInt(m[1], 16));
  for (const m of src.matchAll(/\\u\{?([0-9A-Fa-f]{4,5})\}?/g)) set.add(parseInt(m[1], 16));

  // літеральні діапазони виду [A-B], де A і B не-ASCII
  for (const m of src.matchAll(/([^\x00-\x7f])-([^\x00-\x7f])/g)) {
    const a = m[1].codePointAt(0), b = m[2].codePointAt(0);
    if (a < b) ranges.push([a, b]);
  }
  for (const ch of src) {
    const cp = ch.codePointAt(0);
    if (cp > 0x7f) set.add(cp);
  }

  const clean = new Set([...set].filter(cp => !isNoise(cp)));
  const inRange = cp => ranges.some(([a, b]) => cp >= a && cp <= b);
  return {
    size: clean.size,
    values: () => [...clean],
    has: cp => clean.has(cp) || inRange(cp),
  };
}

const hookSrc = read('claude-code/hooks/check-text.mjs');
// у хука беремо тільки константи, а не українські коментарі й повідомлення
const hook = collectCodes(hookSrc.slice(hookSrc.indexOf('const HARD'), hookSrc.indexOf('function read(')));
hook.size > 0 ? ok(`хук знає ${hook.size} символів`) : bad('не знайшов символів у check-text.mjs');

// Символи, задекларовані в таблицях довідника як заборонені, хук має
// детектувати. Інакше документація і код розійдуться непомітно.
const sym = read('references/symbols.md');
function codesFromTables(src, heading) {
  const from = src.indexOf(heading);
  if (from < 0) return [];
  const rest = src.slice(from + heading.length);
  const to = rest.search(/\n###? /);
  const block = to < 0 ? rest : rest.slice(0, to);
  return [...block.matchAll(/U\+([0-9A-F]{4,5})/g)].map(m => parseInt(m[1], 16));
}

const declared = new Set([
  ...codesFromTables(sym, '### Заборонено завжди'),
  ...codesFromTables(sym, '### Типографські, яких теж немає'),
].filter(cp =>
  cp > 0x7f &&        // ASCII це цілі заміни, а не заборонені символи
  cp < 0x10000        // емодзі поза BMP хук ловить окремо, сурогатними парами
));
// діапазони в таблицях записані як «U+2500 U+2502 та ін.», решта поодинокі
declared.size > 0
  ? ok(`довідник декларує ${declared.size} заборонених символів`)
  : bad('не знайшов таблиць заборонених символів у references/symbols.md');

const hex = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
const undetected = [...declared].filter(cp => !hook.has(cp));
undetected.length === 0
  ? ok('хук детектує все, що заборонено в довіднику')
  : bad(`заборонено в довіднику, але хук не ловить: ${undetected.map(hex).join(' ')}`);

// --- 6. Маркер самовиключення ------------------------------------------
section('Маркер самовиключення');

const MARKER = /tatet-humanizer|plain-text-output|Signs of AI writing/;
const DOCS = [
  'SKILL.md', 'references/symbols.md', 'references/patterns.md',
  'README.md', 'AGENTS.md',
  'claude-code/INSTALL.md', 'claude-code/CLAUDE.snippet.md',
];
let markerFails = 0;
for (const f of DOCS) {
  if (!existsSync(p(f))) continue;
  if (!MARKER.test(read(f))) { bad(`${f}: немає маркера, хук сваритиметься на власну документацію`); markerFails++; }
}
if (!markerFails) ok(`усі ${DOCS.length} документи мають маркер`);

// --- 7. Посилання на references ----------------------------------------
section('Внутрішні посилання');

const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(m => m[1]);
const uniq = [...new Set(links)];
let linkFails = 0;
for (const l of uniq) {
  if (!existsSync(p(l))) { bad(`SKILL.md посилається на неіснуючий ${l}`); linkFails++; }
}
if (!linkFails) ok(`${uniq.length} посилань на references резолвяться`);

// --- Підсумок ----------------------------------------------------------
console.log('');
if (errors) {
  console.log(`ПРОВАЛ: помилок ${errors}, попереджень ${warnings}`);
  process.exit(1);
}
console.log(`Готово: помилок немає, попереджень ${warnings}`);
