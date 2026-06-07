'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Generiere .env beim ersten Start ──────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  const m = crypto.randomBytes(6).toString('hex').toUpperCase();
  const c = crypto.randomBytes(6).toString('hex').toUpperCase();
  const d = crypto.randomBytes(6).toString('hex').toUpperCase();
  fs.writeFileSync(envPath,
    `MITARBEITER_CODE=${m}\nCHEF_CODE=${c}\nDEMO_CODE=${d}\nPORT=3000\n`);
}
require('dotenv').config({ path: envPath });

// DEMO_CODE nachrüsten falls .env bereits existierte
if (!process.env.DEMO_CODE) {
  const d = crypto.randomBytes(6).toString('hex').toUpperCase();
  fs.appendFileSync(envPath, `DEMO_CODE=${d}\n`);
  process.env.DEMO_CODE = d;
}

const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const app = express();
app.use(express.json());

const MITARBEITER_CODE = process.env.MITARBEITER_CODE;
const CHEF_CODE        = process.env.CHEF_CODE;
const DEMO_CODE        = process.env.DEMO_CODE;
const PORT             = parseInt(process.env.PORT || '3000', 10);

// ── Datenbank ─────────────────────────────────────────────────────────────────
const db = new DatabaseSync(path.join(__dirname, 'arbeitszeit.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Wrapper: wandelt BigInt-lastInsertRowid in Number um
function prepare(sql) {
  return db.prepare(sql);
}
function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { ...r, lastInsertRowid: Number(r.lastInsertRowid) };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS zeiten (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    datum          TEXT    NOT NULL,
    start_zeit     TEXT    NOT NULL,
    end_zeit       TEXT    NOT NULL,
    pause_minuten  INTEGER NOT NULL DEFAULT 0,
    dauer_minuten  INTEGER NOT NULL,
    erstellt_am    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS stempeluhr (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    start_zeit TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS aufgaben (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    titel         TEXT    NOT NULL,
    prioritaet    TEXT    NOT NULL DEFAULT 'Mittel',
    notiz         TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'Offen',
    erstellt_von  TEXT    NOT NULL,
    erstellt_am   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    aktualisiert_am TEXT  NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS archiv (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    aufgabe_id    INTEGER,
    titel         TEXT    NOT NULL,
    prioritaet    TEXT    NOT NULL,
    notiz         TEXT    NOT NULL DEFAULT '',
    erstellt_von  TEXT    NOT NULL,
    erstellt_am   TEXT    NOT NULL,
    erledigt_am   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
  );
`);

// ── Neue Tabelle: Urlaub (bestehende Tabellen werden NICHT verändert) ─────────
db.exec(`
  CREATE TABLE IF NOT EXISTS urlaub (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    von_datum   TEXT    NOT NULL,
    bis_datum   TEXT    NOT NULL,
    tage_anzahl INTEGER NOT NULL,
    notiz       TEXT    NOT NULL DEFAULT '',
    erstellt_am TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
  )
`);

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function datumStr(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function zeitStr(d) {
  return String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');
}

function wochenStartDatum(ref) {
  const d = new Date(ref);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return d;
}

// ── Gehaltsperiode: Stichtag 15. des Monats ───────────────────────────────────
const SOLL_STUNDEN_PRO_PERIODE = 35.29;
// Erste anzuzeigende Periode: 15.05.2026 – 14.06.2026
const ARBEITSBEGINN  = '2026-05-15';
// Letzte anzuzeigende Periode beginnt am 15.04.2027 (12 Perioden gesamt)
const PERIODEN_ENDE  = '2027-04-15';

// Start der Gehaltsperiode zum gegebenen Datum (gibt YYYY-MM-DD zurück)
function periodeStart(datumStr) {
  const d = new Date(datumStr + 'T12:00:00');
  if (d.getDate() >= 15) {
    return datumStr.slice(0, 8) + '15';
  }
  // Vor dem 15. → Periode begann am 15. des Vormonats
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 15);
  return prev.getFullYear() + '-' +
    String(prev.getMonth() + 1).padStart(2, '0') + '-15';
}

// Ende der Gehaltsperiode: 14. des auf den Start folgenden Monats
function periodeEnde(startStr) {
  const [y, m] = startStr.split('-').map(Number);
  const next = new Date(y, m, 14); // JS-Monat 0-basiert: m entspricht Folgemonat
  return next.getFullYear() + '-' +
    String(next.getMonth() + 1).padStart(2, '0') + '-14';
}

// Wandelt ein UTC-Date-Objekt in Europe/Berlin Datum + Uhrzeit um
function berlinZeit(d) {
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const p = Object.fromEntries(formatter.formatToParts(d).map(x => [x.type, x.value]));
  return { datum: `${p.year}-${p.month}-${p.day}`, zeit: `${p.hour}:${p.minute}` };
}

// Start des aktuellen Urlaubsjahres (läuft vom 15. Mai bis 14. Mai des Folgejahres)
function urlaubsjahrVon() {
  const heute = new Date();
  const year  = heute.getFullYear();
  return heute >= new Date(year, 4, 15)
    ? `${year}-05-15`
    : `${year - 1}-05-15`;
}

// Zählt Werktage (Mo–Fr) zwischen zwei Datumsstrings (beide Enden inklusiv)
function zaehleArbeitstage(vonStr, bisStr) {
  let count = 0;
  const d   = new Date(vonStr + 'T12:00:00');
  const bis = new Date(bisStr + 'T12:00:00');
  while (d <= bis) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// ── Auth-Middleware ───────────────────────────────────────────────────────────
function auth(req, res, next) {
  const code = req.headers['x-auth-code'];
  if (code === MITARBEITER_CODE) { req.role = 'mitarbeiter'; return next(); }
  if (code === CHEF_CODE)        { req.role = 'chef';        return next(); }
  return res.status(401).json({ error: 'Nicht autorisiert' });
}

function nurMitarbeiter(req, res, next) {
  if (req.role !== 'mitarbeiter')
    return res.status(403).json({ error: 'Nur für Mitarbeiter' });
  next();
}

// ── Frontend-Routen ───────────────────────────────────────────────────────────
app.get('/mitarbeiter/:code', (req, res) => {
  if (req.params.code !== MITARBEITER_CODE) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/chef/:code', (req, res) => {
  if (req.params.code !== CHEF_CODE) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/demo/:code', (req, res) => {
  if (req.params.code !== DEMO_CODE) return res.status(404).end();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Zeiten API ────────────────────────────────────────────────────────────────
app.get('/api/zeiten', auth, (req, res) => {
  const { von, bis } = req.query;
  let rows;
  if (von && bis) {
    rows = db.prepare(
      'SELECT * FROM zeiten WHERE datum BETWEEN ? AND ? ORDER BY datum, start_zeit'
    ).all(von, bis);
  } else {
    rows = db.prepare(
      'SELECT * FROM zeiten ORDER BY datum DESC, start_zeit DESC LIMIT 500'
    ).all();
  }
  res.json(rows);
});

app.post('/api/zeiten', auth, nurMitarbeiter, (req, res) => {
  const { datum, start_zeit, end_zeit, pause_minuten = 0 } = req.body;
  if (!datum || !start_zeit || !end_zeit)
    return res.status(400).json({ error: 'Pflichtfelder fehlen' });

  const s = new Date(`${datum}T${start_zeit}:00`).getTime();
  let   e = new Date(`${datum}T${end_zeit}:00`).getTime();
  if (e <= s) e += 86_400_000; // Mitternacht überschritten
  const dauer = Math.max(0, Math.round((e - s) / 60_000) - Number(pause_minuten));

  const r = db.prepare(
    'INSERT INTO zeiten (datum, start_zeit, end_zeit, pause_minuten, dauer_minuten) VALUES (?,?,?,?,?)'
  ).run(datum, start_zeit, end_zeit, Number(pause_minuten), dauer);
  res.json(db.prepare('SELECT * FROM zeiten WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.put('/api/zeiten/:id', auth, nurMitarbeiter, (req, res) => {
  const { datum, start_zeit, end_zeit, pause_minuten = 0 } = req.body;
  const s = new Date(`${datum}T${start_zeit}:00`).getTime();
  let   e = new Date(`${datum}T${end_zeit}:00`).getTime();
  if (e <= s) e += 86_400_000;
  const dauer = Math.max(0, Math.round((e - s) / 60_000) - Number(pause_minuten));

  db.prepare(
    'UPDATE zeiten SET datum=?, start_zeit=?, end_zeit=?, pause_minuten=?, dauer_minuten=? WHERE id=?'
  ).run(datum, start_zeit, end_zeit, Number(pause_minuten), dauer, req.params.id);
  res.json(db.prepare('SELECT * FROM zeiten WHERE id = ?').get(req.params.id));
});

app.delete('/api/zeiten/:id', auth, nurMitarbeiter, (req, res) => {
  db.prepare('DELETE FROM zeiten WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Stempeluhr API ────────────────────────────────────────────────────────────
app.get('/api/stempeluhr', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM stempeluhr WHERE id = 1').get() || null);
});

app.post('/api/stempeluhr/start', auth, nurMitarbeiter, (req, res) => {
  if (db.prepare('SELECT id FROM stempeluhr WHERE id = 1').get())
    return res.status(400).json({ error: 'Stempeluhr läuft bereits' });
  const now = new Date().toISOString();
  db.prepare('INSERT INTO stempeluhr (id, start_zeit) VALUES (1, ?)').run(now);
  res.json({ start_zeit: now });
});

app.post('/api/stempeluhr/stop', auth, nurMitarbeiter, (req, res) => {
  const row = db.prepare('SELECT * FROM stempeluhr WHERE id = 1').get();
  if (!row) return res.status(400).json({ error: 'Stempeluhr läuft nicht' });

  const start = new Date(row.start_zeit);
  const end   = new Date();
  // Berliner Lokalzeit verwenden – verhindert UTC-Verschiebung auf dem Server
  const startB = berlinZeit(start);
  const endB   = berlinZeit(end);
  const dauer  = Math.max(0, Math.round((end - start) / 60_000));

  const r = db.prepare(
    'INSERT INTO zeiten (datum, start_zeit, end_zeit, pause_minuten, dauer_minuten) VALUES (?,?,?,0,?)'
  ).run(startB.datum, startB.zeit, endB.zeit, dauer);
  db.prepare('DELETE FROM stempeluhr WHERE id = 1').run();
  res.json(db.prepare('SELECT * FROM zeiten WHERE id = ?').get(Number(r.lastInsertRowid)));
});

// ── Stats API ─────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
  const heute = new Date();
  const heuteStr = datumStr(heute);
  const wocheStr = datumStr(wochenStartDatum(heute));
  // Gehaltsperiode: 15. bis 14. (statt Kalendermonat 1. bis 31.)
  const pvon     = periodeStart(heuteStr);
  const pbis     = periodeEnde(pvon);

  const minToH = min => +(min / 60).toFixed(1);

  const hMin = db.prepare('SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum = ?').get(heuteStr).v;
  const wMin = db.prepare('SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum >= ?').get(wocheStr).v;
  const mMin = db.prepare('SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum >= ? AND datum <= ?').get(pvon, pbis).v;

  const taskCounts = { Offen: 0, 'In Arbeit': 0, Blockiert: 0 };
  db.prepare('SELECT status, COUNT(*) c FROM aufgaben WHERE status != ? GROUP BY status').all('Erledigt')
    .forEach(r => { taskCounts[r.status] = r.c; });

  const archivTotal = db.prepare('SELECT COUNT(*) c FROM archiv').get().c;

  res.json({
    zeiten:  { heute: minToH(hMin), woche: minToH(wMin), monat: minToH(mMin) },
    aufgaben: taskCounts,
    archiv:  { total: archivTotal }
  });
});

// ── Chart-Daten ───────────────────────────────────────────────────────────────
app.get('/api/charts/woche', auth, (req, res) => {
  const ref = req.query.datum ? new Date(req.query.datum + 'T12:00:00') : new Date();
  const mo  = wochenStartDatum(ref);
  const tage = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mo);
    d.setDate(mo.getDate() + i);
    const ds = datumStr(d);
    const min = db.prepare('SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum = ?').get(ds).v;
    tage.push({ datum: ds, minuten: min });
  }
  const totalMin = tage.reduce((s, t) => s + t.minuten, 0);
  // Gehaltsperiode zur Wochenmitte (Donnerstag) berechnen
  const pvon = periodeStart(tage[3].datum);
  const pbis = periodeEnde(pvon);
  const periodeMin = db.prepare(
    'SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum >= ? AND datum <= ?'
  ).get(pvon, pbis).v;
  res.json({
    tage, total: +(totalMin / 60).toFixed(1), von: tage[0].datum, bis: tage[6].datum,
    periode: { von: pvon, bis: pbis, stunden: +(periodeMin / 60).toFixed(2), soll: SOLL_STUNDEN_PRO_PERIODE }
  });
});

app.get('/api/charts/monat', auth, (req, res) => {
  const jahr = Number(req.query.jahr) || new Date().getFullYear();
  const monate = [];
  for (let m = 1; m <= 12; m++) {
    // Gehaltsperiode: 15. des Monats bis 14. des Folgemonats
    const vonStr = `${jahr}-${String(m).padStart(2, '0')}-15`;
    const bisStr = periodeEnde(vonStr);
    const min = db.prepare(
      'SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum >= ? AND datum <= ?'
    ).get(vonStr, bisStr).v;
    monate.push({ monat: m, minuten: min, von: vonStr, bis: bisStr });
  }
  res.json({ jahr, monate, soll: SOLL_STUNDEN_PRO_PERIODE });
});

// ── Aufgaben API ──────────────────────────────────────────────────────────────
app.get('/api/aufgaben', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT * FROM aufgaben
    ORDER BY CASE prioritaet WHEN 'Hoch' THEN 0 WHEN 'Mittel' THEN 1 ELSE 2 END, erstellt_am DESC
  `).all());
});

app.post('/api/aufgaben', auth, (req, res) => {
  const { titel, prioritaet = 'Mittel', notiz = '' } = req.body;
  if (!titel?.trim()) return res.status(400).json({ error: 'Titel fehlt' });
  const r = db.prepare(
    'INSERT INTO aufgaben (titel, prioritaet, notiz, erstellt_von) VALUES (?,?,?,?)'
  ).run(titel.trim(), prioritaet, notiz, req.role);
  res.json(db.prepare('SELECT * FROM aufgaben WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.put('/api/aufgaben/:id', auth, nurMitarbeiter, (req, res) => {
  const { titel, prioritaet, notiz } = req.body;
  db.prepare(`
    UPDATE aufgaben SET titel=?, prioritaet=?, notiz=?,
    aktualisiert_am=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?
  `).run(titel, prioritaet, notiz || '', req.params.id);
  res.json(db.prepare('SELECT * FROM aufgaben WHERE id = ?').get(req.params.id));
});

app.patch('/api/aufgaben/:id/status', auth, nurMitarbeiter, (req, res) => {
  const { status } = req.body;
  if (!['Offen', 'In Arbeit', 'Blockiert', 'Erledigt'].includes(status))
    return res.status(400).json({ error: 'Ungültiger Status' });

  const aufgabe = db.prepare('SELECT * FROM aufgaben WHERE id = ?').get(req.params.id);
  if (!aufgabe) return res.status(404).json({ error: 'Nicht gefunden' });

  if (status === 'Erledigt') {
    db.prepare(
      'INSERT INTO archiv (aufgabe_id, titel, prioritaet, notiz, erstellt_von, erstellt_am) VALUES (?,?,?,?,?,?)'
    ).run(aufgabe.id, aufgabe.titel, aufgabe.prioritaet, aufgabe.notiz, aufgabe.erstellt_von, aufgabe.erstellt_am);
    db.prepare('DELETE FROM aufgaben WHERE id = ?').run(aufgabe.id);
    return res.json({ archiviert: true });
  }

  db.prepare(`
    UPDATE aufgaben SET status=?,
    aktualisiert_am=strftime('%Y-%m-%dT%H:%M:%S','now','localtime') WHERE id=?
  `).run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM aufgaben WHERE id = ?').get(req.params.id));
});

app.delete('/api/aufgaben/:id', auth, nurMitarbeiter, (req, res) => {
  db.prepare('DELETE FROM aufgaben WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Archiv API ────────────────────────────────────────────────────────────────
app.get('/api/archiv', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM archiv ORDER BY erledigt_am DESC').all());
});

app.delete('/api/archiv/:id', auth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM archiv WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  res.json({ ok: true });
});

// ── Perioden API ──────────────────────────────────────────────────────────────
// Gibt alle 12 Gehaltsperioden von ARBEITSBEGINN bis PERIODEN_ENDE zurück
// (auch zukünftige Perioden werden angezeigt, dann mit 0 Stunden)
app.get('/api/perioden', auth, (req, res) => {
  const perioden = [];
  let pvon = ARBEITSBEGINN;
  while (pvon <= PERIODEN_ENDE) {
    const pbis = periodeEnde(pvon);
    const min  = db.prepare(
      'SELECT COALESCE(SUM(dauer_minuten),0) v FROM zeiten WHERE datum >= ? AND datum <= ?'
    ).get(pvon, pbis).v;
    perioden.push({ von: pvon, bis: pbis, stunden: +(min / 60).toFixed(2) });
    // Nächste Periode: 15. des folgenden Monats
    const [y, m] = pvon.split('-').map(Number);
    const next   = new Date(y, m, 15); // JS-Monat 0-basiert: m entspricht Folgemonat
    pvon = next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0') + '-15';
  }
  perioden.reverse(); // Neueste zuerst
  res.json({ perioden, soll: SOLL_STUNDEN_PRO_PERIODE });
});

// ── Urlaub API ────────────────────────────────────────────────────────────────
const URLAUB_TAGE_PRO_JAHR = 6;

app.get('/api/urlaub', auth, (req, res) => {
  const alle     = db.prepare('SELECT * FROM urlaub ORDER BY von_datum DESC').all();
  const vonStr   = urlaubsjahrVon();
  const bisStr   = `${parseInt(vonStr.slice(0, 4)) + 1}-05-14`;
  const verbraucht = db.prepare(
    'SELECT COALESCE(SUM(tage_anzahl),0) v FROM urlaub WHERE von_datum >= ? AND von_datum <= ?'
  ).get(vonStr, bisStr).v;
  res.json({
    eintraege: alle,
    jahr: { von: vonStr, bis: bisStr, gesamt: URLAUB_TAGE_PRO_JAHR, verbraucht, verbleibend: URLAUB_TAGE_PRO_JAHR - verbraucht }
  });
});

app.post('/api/urlaub', auth, nurMitarbeiter, (req, res) => {
  const { von_datum, bis_datum, notiz = '' } = req.body;
  if (!von_datum || !bis_datum) return res.status(400).json({ error: 'Pflichtfelder fehlen' });
  if (von_datum > bis_datum)   return res.status(400).json({ error: 'Von-Datum muss vor Bis-Datum liegen' });
  const tage_anzahl = zaehleArbeitstage(von_datum, bis_datum);
  const r = db.prepare(
    'INSERT INTO urlaub (von_datum, bis_datum, tage_anzahl, notiz) VALUES (?,?,?,?)'
  ).run(von_datum, bis_datum, tage_anzahl, notiz);
  res.json(db.prepare('SELECT * FROM urlaub WHERE id = ?').get(Number(r.lastInsertRowid)));
});

app.delete('/api/urlaub/:id', auth, nurMitarbeiter, (req, res) => {
  const { changes } = db.prepare('DELETE FROM urlaub WHERE id = ?').run(Number(req.params.id));
  if (!changes) return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  res.json({ success: true });
});

// ── Fehlerbehandlung ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║          Arbeitszeit-App  –  gestartet!           ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  Mitarbeiter: ${base}/mitarbeiter/${MITARBEITER_CODE}  ║`);
  console.log(`║  Chef:        ${base}/chef/${CHEF_CODE}          ║`);
  console.log(`║  Demo:        ${base}/demo/${DEMO_CODE}          ║`);
  console.log('╚═══════════════════════════════════════════════════╝\n');
});
