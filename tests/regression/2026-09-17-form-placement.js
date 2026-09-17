/**
 * O6: Regression test for PDF form field placement (ISSUE-2026-09-17).
 *
 * Verifies:
 * 1. Auto-matched fields land on correct blanks (no cross-field stealing)
 * 2. Zero placement collisions
 * 3. Each field's value is extractable at the right position
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FORM_FILLER = path.join(__dirname, '../../src/form-filler.py');
const FIXTURE_PDF = path.join(__dirname, '../fixtures/forms/soccer-registration.pdf');

// N4: PyMuPDF is REQUIRED — hard failure.
try {
  execSync('python3 -c "import pymupdf"', { timeout: 5000, stdio: 'pipe' });
} catch (_) {
  module.exports = { async run() { return { pass: false, message: 'PyMuPDF not installed' }; } };
  return;
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ ${msg}`); failed++; }
}

function runTests() {

console.log('\nO6: Form placement — no collisions, correct field separation');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-placement-'));
const fieldsPath = path.join(tmpDir, 'fields.json');
const outputPath = path.join(tmpDir, 'filled.pdf');

const fields = {
  fields: [
    { label: 'שם משפחה', value: 'טסט', source: 'test' },
    { label: 'שם פרטי', value: 'ילד', source: 'test' },
    { label: 'תאריך לידה', value: '1.1.2020', source: 'test' },
    { label: 'כיתה', value: 'ב', source: 'test' },
    { label: 'כתובת', value: 'תל אביב', source: 'test' },
    { label: 'ישוב', value: 'תל אביב', source: 'test' },
    { label: 'שם האם', value: 'אמא', source: 'test' },
    { label: 'שם האב', value: 'אבא', source: 'test' },
  ],
  freetext: [],
  circles: [],
};

fs.writeFileSync(fieldsPath, JSON.stringify(fields), 'utf8');

const stdout = execSync(
  `python3 ${FORM_FILLER} ${FIXTURE_PDF} ${fieldsPath} ${outputPath}`,
  { encoding: 'utf8', timeout: 15000 }
);

const report = JSON.parse(stdout);

// Check no collisions
const collisions = report.collisions || [];
assert(collisions.length === 0, `zero collisions (got ${collisions.length})`);
if (collisions.length > 0) {
  collisions.forEach(c => console.log(`    collision: ${c.field} "${c.value}" hits "${c.collides_with}"`));
}

// Check no errors
assert(report.errors.length === 0, `zero errors (got ${report.errors.length})`);

// Check שם משפחה and שם פרטי land on DIFFERENT x positions
const shimMishpacha = report.filled.find(f => f.field === 'שם משפחה');
const shimPrati = report.filled.find(f => f.field === 'שם פרטי');
assert(shimMishpacha && shimPrati, 'both name fields were placed');
if (shimMishpacha && shimPrati) {
  const xDiff = Math.abs(shimMishpacha.position.x - shimPrati.position.x);
  assert(xDiff > 50, `שם משפחה (x=${shimMishpacha.position.x}) and שם פרטי (x=${shimPrati.position.x}) are separated (diff=${xDiff.toFixed(0)})`);
}

// Check all auto-matched fields use baseline (y1 area, not y0)
const overlayFields = report.filled.filter(f => f.method === 'overlay');
for (const f of overlayFields) {
  // y should be ~244 (y1-2) for top line, not ~236 (y0+2)
  assert(f.position.y > 240 || f.position.y > f.position.y, `${f.field} y=${f.position.y} uses baseline positioning`);
}

// Round-trip: extract text and verify values exist
const extractScript = `
import pymupdf, json
doc = pymupdf.open("${outputPath}")
text = doc[0].get_text()
checks = ["טסט", "ילד", "1.1.2020", "תל אביב", "אמא", "אבא"]
results = {v: v in text for v in checks}
print(json.dumps(results))
doc.close()
`;
const extractResult = execSync(`python3 -c '${extractScript}'`, { encoding: 'utf8', timeout: 10000 });
const roundTrip = JSON.parse(extractResult);
for (const [val, found] of Object.entries(roundTrip)) {
  assert(found, `round-trip: '${val}' found in extracted text`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Form placement: ${passed} passed, ${failed} failed`);
return { pass: failed === 0, message: `${passed} passed, ${failed} failed` };
}

module.exports = {
  async run() { return runTests(); }
};
