// api/worksheet.js
// Node.js Serverless Function (kein Edge-Runtime, da pdf-lib hier läuft).
// Erzeugt per OpenRouter strukturierten Übungsblatt-Inhalt (JSON) und rendert
// daraus serverseitig ein sauber formatiertes PDF, das als Base64 zurückgegeben wird.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const OPENROUTER_MODEL = 'openrouter/free';

const WORKSHEET_SYSTEM_PROMPT = `Du erstellst Arbeitsblätter für den Schulunterricht.
Antworte AUSSCHLIESSLICH mit einem einzigen validen JSON-Objekt (keine Erklärtexte davor/danach, keine Markdown-Codeblöcke) mit exakt diesem Schema:

{
  "title": "Kurzer, prägnanter Titel des Arbeitsblatts",
  "subject": "Fach",
  "gradeLevel": "Klassenstufe, z.B. '7. Klasse'",
  "introduction": "1-2 Sätze Einleitung/Kontext zum Thema für die Schüler",
  "sections": [
    {
      "heading": "Titel des Abschnitts, z.B. 'Aufgabe 1: Grundlagen'",
      "instructions": "Kurze Arbeitsanweisung für diesen Abschnitt",
      "items": [
        { "question": "Aufgabentext", "answerLines": 2 }
      ]
    }
  ],
  "answerKey": [
    { "question": "Kurzfassung/Nummer der Aufgabe", "answer": "Musterlösung" }
  ]
}

Regeln:
- "answerLines" ist die Anzahl Leerzeilen, die auf dem Blatt für die handschriftliche Antwort frei bleiben sollen (1 = kurze Antwort, 3-5 = Rechenweg/Textantwort).
- Erstelle abwechslungsreiche, altersgerechte Aufgaben (z.B. Verständnisfragen, Rechenaufgaben, Lückentexte, Zuordnungen als Text beschrieben).
- "answerKey" nur befüllen, wenn explizit eine Musterlösung gewünscht ist, sonst leeres Array.
- Halte dich an die gewünschte Anzahl Aufgaben (über alle Abschnitte hinweg).
- Schreibe auf Deutsch, außer explizit eine andere Sprache verlangt wird.`;

function buildUserPrompt({ topic, subject, gradeLevel, numTasks, includeAnswerKey, notes }) {
  const parts = [`Thema: ${topic}`];
  if (subject) parts.push(`Fach: ${subject}`);
  if (gradeLevel) parts.push(`Klassenstufe: ${gradeLevel}`);
  parts.push(`Gewünschte Anzahl Aufgaben (ungefähr): ${numTasks || 6}`);
  parts.push(`Musterlösung beilegen: ${includeAnswerKey ? 'Ja' : 'Nein'}`);
  if (notes) parts.push(`Zusätzliche Wünsche/Hinweise: ${notes}`);
  return parts.join('\n');
}

function sendJson(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function extractJsonObject(raw) {
  let text = raw.trim();
  // Falls das Modell trotz Anweisung Markdown-Codefences nutzt, diese entfernen.
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) throw new Error('Keine JSON-Struktur in der KI-Antwort gefunden.');
  return JSON.parse(text.slice(firstBrace, lastBrace + 1));
}

// --- einfache Textumbruch-Hilfe für pdf-lib (das von sich aus keinen Umbruch kann) ---
function wrapText(text, font, size, maxWidth) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      error: 'Server ist nicht konfiguriert: Die Umgebungsvariable OPENROUTER_API_KEY fehlt in Vercel.',
    });
  }

  const { topic, subject, gradeLevel, numTasks, includeAnswerKey, notes } = req.body || {};
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return sendJson(res, 400, { error: 'Bitte gib ein Thema für das Arbeitsblatt an.' });
  }

  let content;
  try {
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers.origin || 'https://vercel.app',
        'X-Title': 'Schlaufuchs Schul-KI',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: WORKSHEET_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt({ topic, subject, gradeLevel, numTasks, includeAnswerKey, notes }) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.6,
      }),
    });

    if (!orRes.ok) {
      const errText = await orRes.text().catch(() => '');
      return sendJson(res, 502, { error: `OpenRouter-Fehler (${orRes.status}): ${errText.slice(0, 500)}` });
    }

    const orJson = await orRes.json();
    const raw = orJson?.choices?.[0]?.message?.content || '';
    content = extractJsonObject(raw);
  } catch (err) {
    return sendJson(res, 500, { error: `Inhalt konnte nicht erzeugt werden: ${err.message}` });
  }

  try {
    const pdfBase64 = await renderWorksheetPdf(content, !!includeAnswerKey);
    return sendJson(res, 200, {
      pdfBase64,
      filename: `${slugify(content.title || topic)}.pdf`,
      title: content.title || topic,
    });
  } catch (err) {
    return sendJson(res, 500, { error: `PDF konnte nicht erstellt werden: ${err.message}` });
  }
};

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[äöüß]/g, (m) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m]))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'arbeitsblatt'
  );
}

async function renderWorksheetPdf(data, includeAnswerKey) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 56;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const ink = rgb(0.13, 0.13, 0.15);
  const muted = rgb(0.42, 0.42, 0.46);
  const accent = rgb(0.75, 0.22, 0.2);
  const lineColor = rgb(0.82, 0.82, 0.8);

  let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  function newPage() {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  function ensureSpace(need) {
    if (y - need < MARGIN) newPage();
  }
  function drawWrapped(text, { size = 11, f = font, color = ink, lineGap = 5, x = MARGIN, width = CONTENT_W } = {}) {
    const lines = wrapText(text, f, size, width);
    for (const line of lines) {
      ensureSpace(size + lineGap);
      page.drawText(line, { x, y, size, font: f, color });
      y -= size + lineGap;
    }
  }
  function drawAnswerLines(count) {
    const gap = 20;
    for (let i = 0; i < count; i++) {
      ensureSpace(gap);
      page.drawLine({
        start: { x: MARGIN + 14, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 0.8,
        color: lineColor,
      });
      y -= gap;
    }
  }

  // Kopfbereich
  drawWrapped(data.title || 'Arbeitsblatt', { size: 22, f: bold, color: ink, lineGap: 6 });
  const metaBits = [data.subject, data.gradeLevel].filter(Boolean).join('  ·  ');
  if (metaBits) drawWrapped(metaBits, { size: 11, color: muted, lineGap: 4 });
  y -= 6;
  page.drawText('Name: ______________________________        Datum: ____________', {
    x: MARGIN,
    y,
    size: 10.5,
    font,
    color: muted,
  });
  y -= 16;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.4, color: accent });
  y -= 22;

  if (data.introduction) {
    drawWrapped(data.introduction, { size: 11, color: muted });
    y -= 8;
  }

  let taskNumber = 1;
  const sections = Array.isArray(data.sections) ? data.sections : [];

  for (const section of sections) {
    ensureSpace(50);
    if (section.heading) {
      y -= 6;
      drawWrapped(section.heading, { size: 14, f: bold, color: ink, lineGap: 5 });
    }
    if (section.instructions) {
      drawWrapped(section.instructions, { size: 10.5, color: muted, lineGap: 4 });
    }
    y -= 4;

    const items = Array.isArray(section.items) ? section.items : [];
    for (const item of items) {
      ensureSpace(24);
      const label = `${taskNumber}. `;
      const labelWidth = bold.widthOfTextAtSize(label, 11.5);
      page.drawText(label, { x: MARGIN, y, size: 11.5, font: bold, color: ink });
      const lines = wrapText(item.question || '', font, 11.5, CONTENT_W - labelWidth);
      lines.forEach((line, idx) => {
        if (idx > 0) ensureSpace(17);
        page.drawText(line, { x: MARGIN + labelWidth, y, size: 11.5, font, color: ink });
        y -= 17;
      });
      const answerLines = Math.max(0, Math.min(8, Number(item.answerLines) || 2));
      drawAnswerLines(answerLines);
      y -= 6;
      taskNumber += 1;
    }
    y -= 6;
  }

  const answerKey = Array.isArray(data.answerKey) ? data.answerKey : [];
  if (includeAnswerKey && answerKey.length > 0) {
    newPage();
    drawWrapped('Musterlösung', { size: 18, f: bold, color: accent, lineGap: 6 });
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: lineColor });
    y -= 18;
    answerKey.forEach((entry, idx) => {
      ensureSpace(24);
      const label = `${idx + 1}. `;
      const labelWidth = bold.widthOfTextAtSize(label, 11);
      page.drawText(label, { x: MARGIN, y, size: 11, font: bold, color: ink });
      const lines = wrapText(entry.answer || '', font, 11, CONTENT_W - labelWidth);
      lines.forEach((line, i) => {
        if (i > 0) ensureSpace(16);
        page.drawText(line, { x: MARGIN + labelWidth, y, size: 11, font, color: ink });
        y -= 16;
      });
      y -= 6;
    });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes).toString('base64');
}
