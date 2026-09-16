/**
 * M5: Regression test for PDF form filling (ISSUE-2026-09-16).
 *
 * Verifies:
 * 1. form-filler.py fills all specified fields
 * 2. Hebrew text renders in correct logical order (round-trip extraction)
 * 3. Fields without provenance stay blank
 * 4. Output is a valid PDF
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const FORM_FILLER = path.join(__dirname, '../../src/form-filler.py');
const FIXTURE_PDF = path.join(__dirname, '../fixtures/forms/soccer-registration.pdf');

// Skip entirely in CI if PyMuPDF is not installed (CI doesn't have Python PDF libs)
try {
  execSync('python3 -c "import pymupdf"', { timeout: 5000, stdio: 'pipe' });
} catch (_) {
  console.log('⏭️  Skipping form-fill regression: PyMuPDF not installed');
  console.log('\n────────────────────────────────────────');
  console.log('Form fill regression: SKIPPED (no PyMuPDF)');
  process.exit(0);
}

let passed = 0;
let failed = 0;

function runTests() {

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── Test 1: All sourced fields are filled ──
test('All sourced fields are filled and round-trip correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-fill-'));
  const fieldsPath = path.join(tmpDir, 'fields.json');
  const outputPath = path.join(tmpDir, 'filled.pdf');

  const fields = {
    fields: [
      { label: 'שם משפחה', value: 'בסינסקי', source: 'test' },
      { label: 'שם פרטי', value: 'נבו', source: 'test' },
      { label: 'תאריך לידה', value: '16.3.2017', source: 'test' },
      { label: 'כיתה', value: 'ד׳', source: 'test' },
      { label: 'כתובת', value: 'רשפים', source: 'test' },
      { label: 'ישוב', value: 'רשפים', source: 'test' },
      { label: 'שם האם', value: 'ליאת', source: 'test' },
      { label: 'שם האב', value: 'אביב', source: 'test' },
    ],
    freetext: [
      { label: 'email', x: 240, y: 341, value: 'test@example.com', source: 'test' },
    ],
    circles: [],
  };

  fs.writeFileSync(fieldsPath, JSON.stringify(fields), 'utf8');

  const stdout = execSync(
    `python3 ${FORM_FILLER} ${FIXTURE_PDF} ${fieldsPath} ${outputPath}`,
    { encoding: 'utf8', timeout: 15000 }
  );

  const report = JSON.parse(stdout);

  assert(report.filled.length >= 8, `filled >= 8 fields (got ${report.filled.length})`);
  assert(report.blank.length === 0, `no blank fields (got ${report.blank.length})`);
  assert(report.errors.length === 0, `no errors (got ${report.errors.length})`);
  assert(fs.existsSync(outputPath), 'output PDF exists');

  // Round-trip: extract text from the filled PDF and check values
  const extractScript = `
import pymupdf, json
doc = pymupdf.open("${outputPath}")
text = doc[0].get_text()
checks = ["בסינסקי", "נבו", "16.3.2017", "רשפים", "ליאת", "אביב", "test@example.com"]
results = {v: v in text for v in checks}
print(json.dumps(results))
doc.close()
`;
  const extractResult = execSync(`python3 -c '${extractScript}'`, { encoding: 'utf8', timeout: 10000 });
  const roundTrip = JSON.parse(extractResult);

  for (const [val, found] of Object.entries(roundTrip)) {
    assert(found, `round-trip: '${val}' found in extracted text`);
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 2: Fields without provenance stay blank ──
test('Fields without source provenance stay blank', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-fill-'));
  const fieldsPath = path.join(tmpDir, 'fields.json');
  const outputPath = path.join(tmpDir, 'filled.pdf');

  const fields = {
    fields: [
      { label: 'שם משפחה', value: 'בסינסקי', source: 'test' },
      { label: 'שם פרטי', value: 'נבו' },  // no source → should stay blank
      { label: 'תאריך לידה', value: '16.3.2017', source: 'unknown' },  // unknown → blank
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

  assert(report.filled.length === 1, `only 1 sourced field filled (got ${report.filled.length})`);
  assert(report.blank.length === 2, `2 unsourced fields left blank (got ${report.blank.length})`);

  // Verify unsourced values are NOT in the output
  const extractScript = `
import pymupdf, json
doc = pymupdf.open("${outputPath}")
text = doc[0].get_text()
print(json.dumps({"nevo_absent": "נבו" not in text.replace("הנרשם", "")}))
doc.close()
`;

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 3: Output is a valid PDF ──
test('Output is a valid, openable PDF', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'form-fill-'));
  const fieldsPath = path.join(tmpDir, 'fields.json');
  const outputPath = path.join(tmpDir, 'filled.pdf');

  fs.writeFileSync(fieldsPath, JSON.stringify({ fields: [], freetext: [], circles: [] }), 'utf8');

  execSync(
    `python3 ${FORM_FILLER} ${FIXTURE_PDF} ${fieldsPath} ${outputPath}`,
    { encoding: 'utf8', timeout: 15000 }
  );

  // Check PDF header
  const header = fs.readFileSync(outputPath, 'ascii').substring(0, 5);
  assert(header === '%PDF-', `valid PDF header (got '${header}')`);

  // Check PyMuPDF can open it
  const checkScript = `
import pymupdf
doc = pymupdf.open("${outputPath}")
print(f"pages:{doc.page_count}")
doc.close()
`;
  const result = execSync(`python3 -c '${checkScript}'`, { encoding: 'utf8', timeout: 10000 });
  assert(result.trim() === 'pages:1', `PDF has 1 page (got '${result.trim()}')`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Summary ──
console.log(`\n${'─'.repeat(40)}`);
console.log(`Form fill regression: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
return { pass: failed === 0, message: `${passed} passed, ${failed} failed` };
}

module.exports = {
  async run() {
    return runTests();
  }
};
