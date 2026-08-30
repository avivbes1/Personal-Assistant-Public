/**
 * Bridge: runs the Baileys compatibility-shim fixture suite (tests/shim/) as part
 * of `npm test` / CI. The real assertions live in tests/shim/shim.test.js; this
 * file only re-exports run() so tests/run-all.js (which scans tests/regression/)
 * picks it up. See WORKPLAN-V4 H5 and PRINCIPLES P-014.
 */
module.exports = require('../shim/shim.test');
