// api/generate-pdf.js
// Node.js Serverless Function (kein Edge-Runtime, da pdf-lib hier läuft).
// Nimmt Titel + einfachen Markdown-Text entgegen, den die Chat-KI bereits im
// Gespräch erzeugt hat (siehe ```pdf-Codeblock in api/chat.js), und rendert
// daraus serverseitig ein sauber formatiertes PDF. Es wird HIER keine
// weitere OpenRouter-Anfrage gestellt - der Inhalt kommt vollständig aus dem
// bereits geführten Chat.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

function sendJson(res, status, obj) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[äöüß]/g, (m) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m]))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'dokument'
  );
}

// Zerlegt eine Zeile in {text, bold} Segmente anhand von **fett**-Markierungen.
function parseInline(line) {
  const segments = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), bold: false });
    segments.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < line.length) segments.push({ text: line.slice(last), bold: false });
  return segments.length ? segments : [{ text: line, bold: false }];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Nur POST erlaubt.' });
  }

  const { title, content } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return sendJson(res, 400, { error: 'Kein Inhalt für das PDF übergeben.' });
  }

  const safeTitle = (typeof title === 'string' && title.trim()) ? title.trim() : 'Dokument';

  try {
    const pdfBase64 = await renderMarkdownPdf(safeTitle, content);
    return sendJson(res, 200, {
      pdfBase64,
      filename: `${slugify(safeTitle)}.pdf`,
      title: safeTitle,
    });
  } catch (err) {
    return sendJson(res, 500, { error: `PDF konnte nicht erstellt werden: ${err.message}` });
  }
};

async function renderMarkdownPdf(title, content) {
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

  // Zeichnet gemischt fett/normale Segmente mit Wortumbruch und optionalem
  // Einzug (für hängende Listen-Einrückung).
  function drawInlineWrapped(segments, opts) {
    const { size = 11.5, color = ink, lineGap = 6, indent = 0 } = opts || {};
    const maxW = CONTENT_W - indent;

    const words = [];
    segments.forEach((seg) => {
      seg.text.split(/(\s+)/).forEach((tok) => {
        if (tok === '') return;
        words.push({ text: tok, f: seg.bold ? bold : font });
      });
    });

    let lineWords = [];
    let lineWidth = 0;

    function flushLine() {
      if (lineWords.length === 0) return;
      ensureSpace(size + lineGap);
      let cx = MARGIN + indent;
      for (const w of lineWords) {
        page.drawText(w.text, { x: cx, y, size, font: w.f, color });
        cx += w.f.widthOfTextAtSize(w.text, size);
      }
      y -= size + lineGap;
      lineWords = [];
      lineWidth = 0;
    }

    for (const w of words) {
      const isSpace = /^\s+$/.test(w.text);
      if (isSpace && lineWords.length === 0) continue;
      const wWidth = w.f.widthOfTextAtSize(w.text, size);
      if (lineWidth + wWidth > maxW && lineWords.length > 0 && !isSpace) {
        flushLine();
      }
      lineWords.push(w);
      lineWidth += wWidth;
    }
    flushLine();
  }

  function drawHeading(text, level) {
    const sizes = { 1: 20, 2: 16.5, 3: 14 };
    const size = sizes[level] || 13;
    ensureSpace(size + 10);
    drawInlineWrapped(parseInline(text), { size, color: level === 1 ? accent : ink, lineGap: 6 });
    y -= 4;
  }

  function drawParagraph(text) {
    drawInlineWrapped(parseInline(text), { size: 11.5, lineGap: 6 });
    y -= 6;
  }

  function drawListItem(text, ordered, index) {
    const marker = ordered ? `${index}. ` : '•  ';
    ensureSpace(20);
    page.drawText(marker, { x: MARGIN, y, size: 11.5, font: bold, color: ink });
    const markerWidth = bold.widthOfTextAtSize(marker, 11.5);
    drawInlineWrapped(parseInline(text), { size: 11.5, lineGap: 6, indent: markerWidth });
    y -= 4;
  }

  function drawHr() {
    ensureSpace(14);
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.8, color: lineColor });
    y -= 14;
  }

  // ---- Kopfbereich ----
  drawInlineWrapped([{ text: title, bold: true }], { size: 21, color: ink, lineGap: 7 });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1.4, color: accent });
  y -= 20;

  // ---- Inhalt zeilenweise parsen (einfaches Markdown) ----
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  let orderedIndex = 0;
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length) {
      drawParagraph(paragraphBuffer.join(' '));
      paragraphBuffer = [];
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      flushParagraph();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushParagraph();
      drawHr();
      orderedIndex = 0;
      continue;
    }
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      drawHeading(headingMatch[2], headingMatch[1].length);
      orderedIndex = 0;
      continue;
    }
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      drawListItem(bulletMatch[1], false);
      orderedIndex = 0;
      continue;
    }
    const olMatch = line.match(/^\d+[.)]\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      orderedIndex += 1;
      drawListItem(olMatch[1], true, orderedIndex);
      continue;
    }
    orderedIndex = 0;
    paragraphBuffer.push(line);
  }
  flushParagraph();

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes).toString('base64');
}
