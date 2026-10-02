// Lists t('...') / t("...") strings used in views/ and src/ that have no
// entry in src/i18n/ko.json (they'd show in English in Korean mode), and
// dictionary entries no longer used anywhere. Run: npm run i18n:check
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ko = require('../src/i18n/ko.json');

const files = [];
function walk(dir, pattern) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, pattern);
    else if (pattern.test(f)) files.push(p);
  }
}
walk(path.join(root, 'views'), /\.pug$/);
walk(path.join(root, 'src'), /\.js$/);

const used = new Map();
const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let m;
  while ((m = re.exec(src)) !== null) {
    const s = m[2].replace(/\\(['"\\])/g, '$1');
    if (!used.has(s)) used.set(s, path.relative(root, file));
  }
}

const missing = [...used].filter(([s]) => !(s in ko) && s !== '');
const unused = Object.keys(ko).filter((k) => !used.has(k) && !k.startsWith('@'));
console.log(`${used.size} strings used, ${Object.keys(ko).length} in ko.json`);
if (missing.length) {
  console.log(`\nMissing Korean (${missing.length}):`);
  for (const [s, f] of missing) console.log(`  [${f}] ${s}`);
}
if (unused.length) {
  console.log(`\nIn ko.json but not found as a t('...') literal (${unused.length}) - fine if used dynamically:`);
  for (const s of unused) console.log('  ' + s);
}
process.exitCode = missing.length ? 1 : 0;
