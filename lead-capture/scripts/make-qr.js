// Usage: node scripts/make-qr.js [url]   -> qr-affiche.png + qr-affiche.svg
const QRCode = require('qrcode');
const url = process.argv[2] || 'https://lead.azomedia.site/qr?s=affiche';
(async () => {
  await QRCode.toFile('qr-affiche.png', url, { width: 1200, margin: 2, errorCorrectionLevel: 'H' });
  await QRCode.toFile('qr-affiche.svg', url, { type: 'svg', margin: 2, errorCorrectionLevel: 'H' });
  console.log('QR généré pour', url);
})();
