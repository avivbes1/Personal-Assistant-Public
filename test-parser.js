require('dotenv').config();
const { extractFromText } = require('./src/parser');
const msg = 'תזכיר לי מחר בשעה 7:30 להביא טיפות פנסטיל למשפחת בן טולילה';
console.log('Input:', msg);
console.log('Result:', JSON.stringify(extractFromText(msg), null, 2));
