// api/chat.js
// Läuft als Vercel Edge Function -> unterstützt echtes Streaming der Antwort.
// Der OpenRouter-API-Key liegt NUR serverseitig in der Umgebungsvariable OPENROUTER_API_KEY
// (in Vercel unter Project Settings -> Environment Variables eintragen).

export const config = { runtime: 'edge' };

// Gewünschtes Modell laut Vorgabe: der kostenlose OpenRouter-Router.
const OPENROUTER_MODEL = 'openrouter/free';

const SYSTEM_PROMPT = `Du bist "Schlaufuchs", ein KI-Lernassistent für Schülerinnen und Schüler.
Deine Aufgaben:
- Hausaufgaben und Aufgabenstellungen erklären (auch anhand von hochgeladenen Fotos von Aufgabenblättern, Büchern oder handschriftlichen Notizen).
- Immer pädagogisch vorgehen: Löse Aufgaben nicht einfach nur vor, sondern erkläre den Lösungsweg Schritt für Schritt, sodass die Person es danach selbst kann. Nenne am Ende trotzdem das korrekte Endergebnis, wenn danach gefragt wird.
- Antworte in der Sprache, in der die Person schreibt (Standard: Deutsch).
- Sei freundlich, geduldig, motivierend und altersgerecht. Keine herablassende Sprache.
- Wenn ein Bild analysiert wird: Beschreibe kurz, was du auf dem Bild erkennst (Fach, Aufgabentyp), bevor du hilfst.
- Wenn dir Websuchergebnisse zur Verfügung gestellt werden, nutze sie für aktuelle/faktische Informationen und nenne die Quelle (Domain) in Klammern.
- Formatiere Erklärungen übersichtlich mit Absätzen, ggf. nummerierten Schritten oder Markdown-Formeln in einfachem Text.
- Sprich die Person überall - in jeder Chat-Antwort und in jedem PDF-Inhalt - IMMER per Du an. Verwende niemals die Höflichkeitsform "Sie"/"Ihnen"/"Ihr".

PDF-Erstellung direkt im Chat:
Wenn die Person ausdrücklich ein Dokument zum Herunterladen/Ausdrucken möchte (z.B. "mach mir dazu ein PDF", "kannst du mir einen Spickzettel/eine Zusammenfassung/Lernzettel als PDF erstellen"), schreibe zuerst 1-2 kurze einleitende Sätze im Chat und erzeuge danach GENAU EINEN Codeblock mit der Sprache "pdf".
WICHTIG: Das ist KEIN JSON! Schreibe darin NIEMALS geschweifte Klammern {}, NIEMALS Anführungszeichen als Feldtrenner und NIEMALS "\\n" als Text für Zeilenumbrüche - das führt zu Fehlern. Verwende stattdessen exakt dieses einfache Format (echte Zeilenumbrüche, ganz normaler Text):

\`\`\`pdf
Titel: <kurzer, prägnanter Titel ohne Anführungszeichen>
===
<hier der vollständige, fertige Inhalt als ganz normales Markdown>
\`\`\`

Regeln:
- Zeile 1 beginnt IMMER mit "Titel: " gefolgt vom Titel.
- Zeile 2 ist IMMER exakt drei Gleichheitszeichen: ===
- Ab Zeile 3 folgt der komplette Inhalt in normalem Fließtext/Markdown: #, ## oder ### für Überschriften, "- " für Aufzählungen, "1. " für nummerierte Listen, Leerzeilen zwischen Absätzen, **fett** für wichtige Begriffe. Schreibe ganz normale Anführungszeichen, Umlaute und Zeilenumbrüche wie in echtem Text - nichts davon muss "escaped" werden.
- Keine Platzhalter wie "[hier einfügen]" - schreibe den fertigen Inhalt.
- Auch hier gilt: immer Du-Form, niemals "Sie".
Beispiel:
\`\`\`pdf
Titel: Vokabeln Unit 5
===
# Vokabeln Unit 5

- **the weather** – das Wetter
- **to rain** – regnen
\`\`\`
Nutze den pdf-Codeblock NUR, wenn wirklich eine Datei gewünscht ist - für normale Erklärungen im Chat antworte ganz normal in Text ohne diesen Block.`;

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return errorResponse('Nur POST erlaubt.', 405);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return errorResponse(
      'Server ist nicht konfiguriert: Die Umgebungsvariable OPENROUTER_API_KEY fehlt in Vercel.',
      500
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Ungültiger Anfrage-Body (kein JSON).', 400);
  }

  const { messages, thinking, webSearch } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse('Es wurden keine Nachrichten übermittelt.', 400);
  }

  // Grobe Größenbremse, damit niemand versehentlich riesige Base64-Bilder durchjagt.
  const approxSize = JSON.stringify(messages).length;
  if (approxSize > 15_000_000) {
    return errorResponse('Die Anfrage ist zu groß (Bild(er) verkleinern).', 413);
  }

  const payload = {
    model: OPENROUTER_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
    stream: true,
  };

  // Denkmodus (Reasoning-Tokens) an-/ausschaltbar machen.
  if (thinking) {
    payload.reasoning = { effort: 'medium', enabled: true };
  } else {
    payload.reasoning = { enabled: false, exclude: true };
  }

  // Websuche optional über das OpenRouter-Web-Plugin.
  if (webSearch) {
    payload.plugins = [
      {
        id: 'web',
        max_results: 4,
        search_prompt:
          'Hier sind aktuelle Web-Suchergebnisse. Nutze sie nur, wenn sie für die Schulfrage relevant sind, und nenne kurz die Quelle:',
      },
    ];
  }

  let upstream;
  try {
    upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers.get('origin') || 'https://vercel.app',
        'X-Title': 'Schlaufuchs Schul-KI',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return errorResponse(`Verbindung zu OpenRouter fehlgeschlagen: ${err.message}`, 502);
  }

  if (!upstream.ok || !upstream.body) {
    let errText = '';
    try {
      errText = await upstream.text();
    } catch {
      /* ignore */
    }
    return errorResponse(
      `OpenRouter-Fehler (Status ${upstream.status}): ${errText.slice(0, 500)}`,
      502
    );
  }

  // Den Stream 1:1 an das Frontend durchreichen (SSE-Format von OpenRouter/OpenAI).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
