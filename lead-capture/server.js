const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'leads.jsonl');
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/qr', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Anti-spam : 5 envois / 10 min / IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 5;
}

const clean = (v, max) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

async function notify(lead) {
  const { EVO_URL, EVO_INSTANCE, EVO_APIKEY, NOTIFY_NUMBER } = process.env;
  if (!EVO_URL || !EVO_APIKEY || !NOTIFY_NUMBER) return;
  const text = `🔔 Nouveau lead démo\n${lead.nom}${lead.entreprise ? ' — ' + lead.entreprise : ''}\n📞 ${lead.telephone}\n🎯 ${lead.besoin}\nhttps://wa.me/${lead.telephone.replace(/\D/g, '')}`;
  try {
    await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVO_APIKEY },
      body: JSON.stringify({ number: NOTIFY_NUMBER, text }),
    });
  } catch (e) {
    console.error('Notification WhatsApp échouée:', e.message);
  }
}

app.post('/api/lead', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot : on fait semblant
  if (limited(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie plus tard.' });

  const lead = {
    nom: clean(b.nom, 80),
    telephone: clean(b.telephone, 25),
    entreprise: clean(b.entreprise, 80),
    besoin: clean(b.besoin, 60),
    source: clean(b.source, 30) || 'direct',
    date: new Date().toISOString(),
  };
  if (lead.nom.length < 2) return res.status(400).json({ error: 'Indique ton nom.' });
  if (lead.telephone.replace(/\D/g, '').length < 8) return res.status(400).json({ error: 'Numéro WhatsApp invalide.' });

  fs.appendFileSync(FILE, JSON.stringify(lead) + '\n');
  notify(lead);
  res.json({ ok: true });
});

// Consultation des leads (Basic Auth)
app.get('/admin/leads', (req, res) => {
  const pass = process.env.ADMIN_PASSWORD;
  const auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [, p] = Buffer.from(auth, 'base64').toString().split(':');
  if (!pass || p !== pass) {
    res.set('WWW-Authenticate', 'Basic realm="Leads"');
    return res.status(401).send('Accès refusé');
  }
  const rows = fs.existsSync(FILE)
    ? fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).reverse()
    : [];
  if (req.query.format === 'csv') {
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    res.type('text/csv').send(
      ['date,nom,telephone,entreprise,besoin,source']
        .concat(rows.map(r => [r.date, r.nom, r.telephone, r.entreprise, r.besoin, r.source].map(esc).join(',')))
        .join('\n')
    );
    return;
  }
  res.json(rows);
});

app.listen(PORT, () => console.log(`Lead capture sur http://localhost:${PORT}`));
