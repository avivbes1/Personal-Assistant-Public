const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', async (qr) => {
  console.log('RAW_QR:' + qr);
  await QRCode.toFile('/tmp/whatsapp-qr2.png', qr, {
    errorCorrectionLevel: 'H',
    width: 600,
    margin: 2
  });
  console.log('saved');
  setTimeout(() => process.exit(0), 500);
});

setTimeout(() => { console.log('timeout'); process.exit(1); }, 25000);
client.initialize().catch(() => {});
