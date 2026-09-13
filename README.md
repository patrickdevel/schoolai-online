# 🦊 Schlaufuchs – Schul-KI-Assistent

Ein Chatbot im Stil von ChatGPT, aber speziell für die Schule:

- **Chat mit Bildanalyse** – Foto von Hausaufgaben/Aufgabenblatt hochladen, die KI erklärt und hilft Schritt für Schritt.
- **Arbeitsblatt-Generator** – Thema eingeben → die KI erstellt Aufgaben → wird serverseitig zu einem sauberen **PDF** gerendert, inkl. Live-Vorschau im Browser und Download-Button.
- **Denkmodus („Nachdenken“)** – kann ein-/ausgeschaltet werden. Wenn an, zeigt die KI ihren Gedankengang in einem eigenen, ausklappbaren Kasten oberhalb der Antwort.
- **Internet-Suche** – optional zuschaltbar, damit die KI für aktuelle/faktische Fragen im Web nachschauen kann.
- Läuft komplett über **GitHub + Vercel** und **OpenRouter** (Modell: `openrouter/free`, kostenlos).
- Der OpenRouter-API-Key liegt **nur** serverseitig als Vercel-Umgebungsvariable – niemals im Frontend-Code.

Kein Build-Schritt, kein Framework: reines HTML/CSS/JS + zwei kleine Vercel-Functions.

---

## 1. Projektstruktur

```
schlaufuchs/
├── index.html          # Komplettes Frontend (Chat + Arbeitsblatt-Generator)
├── api/
│   ├── chat.js          # Streaming-Chat-Endpunkt (Vercel Edge Function)
│   └── worksheet.js      # Arbeitsblatt-Endpunkt: KI-Inhalt → PDF (Vercel Node Function)
├── package.json         # Abhängigkeit: pdf-lib (für die PDF-Erstellung)
├── vercel.json          # Timeout-Einstellungen für die Functions
└── .gitignore
```

## 2. OpenRouter-API-Key besorgen

1. Auf [openrouter.ai](https://openrouter.ai) registrieren (kostenlos).
2. Unter **Keys** einen neuen API-Key erstellen und kopieren.
3. Das genutzte Modell ist `openrouter/free` – der kostenlose Modell-Router von OpenRouter. Für Websuche und ggf. sehr viele Anfragen können auf manchen Konten trotzdem geringe Kosten/Limits anfallen (siehe Hinweis unten) – für normalen Schulgebrauch reicht der kostenlose Tarif in aller Regel aus.

## 3. Projekt auf GitHub hochladen

```bash
git init
git add .
git commit -m "Erste Version: Schlaufuchs Schul-KI"
git branch -M main
git remote add origin https://github.com/DEIN-NAME/schlaufuchs.git
git push -u origin main
```

## 4. Mit Vercel deployen

1. Auf [vercel.com](https://vercel.com) einloggen (z. B. mit GitHub-Account).
2. **Add New → Project** und das eben erstellte GitHub-Repo auswählen.
3. Framework-Preset: **Other** lassen (kein Build-Command nötig, Output = Projekt-Root). Vercel erkennt `index.html` automatisch als statische Seite und alles unter `/api` automatisch als Serverless/Edge-Functions.
4. **Wichtig – Environment Variable setzen**, bevor du auf „Deploy“ klickst (oder danach unter *Project Settings → Environment Variables*):

   | Name | Wert |
   |---|---|
   | `OPENROUTER_API_KEY` | dein OpenRouter-API-Key |

   Für alle drei Umgebungen (Production, Preview, Development) aktivieren.
5. **Deploy** klicken. Nach ein paar Sekunden ist die Seite live unter `https://dein-projekt.vercel.app`.

Wenn du die Umgebungsvariable nachträglich änderst, musst du in Vercel einmal **Redeploy** auslösen, damit sie greift.

## 5. Lokal testen (optional)

```bash
npm install -g vercel
npm install
vercel dev
```
Dann fragt `vercel dev` nach dem `OPENROUTER_API_KEY` bzw. du legst lokal eine Datei `.env.local` mit
```
OPENROUTER_API_KEY=sk-or-...
```
an (diese Datei wird durch `.gitignore` nicht mit hochgeladen).

## 6. Wie es technisch funktioniert

- **`api/chat.js`** läuft als *Vercel Edge Function* (für echtes Text-Streaming). Sie nimmt den bisherigen Gesprächsverlauf inkl. evtl. Bildern (als Base64-Data-URLs) entgegen, ergänzt einen System-Prompt für pädagogisches Verhalten und leitet die Anfrage an `https://openrouter.ai/api/v1/chat/completions` weiter (`stream: true`). Die Antwort wird 1:1 als Server-Sent-Events an den Browser durchgereicht.
  - **Denkmodus:** Wird per `reasoning: { enabled: true }` an OpenRouter übergeben; die zurückkommenden `delta.reasoning`-Tokens werden im Frontend in einem eigenen aufklappbaren Kasten angezeigt.
  - **Internet-Suche:** Wird per `plugins: [{ id: "web" }]` (offizielles OpenRouter-Web-Plugin, nutzt im Hintergrund u. a. Exa) aktiviert.
- **`api/worksheet.js`** läuft als normale Node-Function. Sie lässt die KI ein striktes JSON mit Titel, Einleitung, Aufgaben-Abschnitten und optionaler Musterlösung erzeugen und baut daraus serverseitig mit **pdf-lib** ein formatiertes, mehrseitiges DIN-A4-PDF (inkl. Namensfeld, Linien zum handschriftlichen Ausfüllen, optionaler Lösungsseite). Das PDF wird als Base64-String zurückgegeben; das Frontend macht daraus einen Blob für die Live-Vorschau (`<iframe>`) und den Download-Button.

## 7. Grenzen & Hinweise

- `openrouter/free` wählt automatisch ein zufälliges kostenloses Modell aus dem OpenRouter-Angebot – Qualität und Geschwindigkeit können daher leicht schwanken. Für zuverlässigere Ergebnisse kannst du `OPENROUTER_MODEL` in `api/chat.js` bzw. `api/worksheet.js` später auf ein festes Modell ändern (z. B. ein bestimmtes `:free`-Modell von OpenRouter).
- Die Websuche verursacht laut OpenRouter auch bei kostenlosen Modellen geringe Zusatzkosten pro Suchanfrage – bei intensiver Schulnutzung ggf. das OpenRouter-Guthaben/-Limit im Auge behalten.
- Auf dem kostenlosen Vercel-Plan (Hobby) sind Functions standardmäßig zeitlich begrenzt; `vercel.json` setzt hier bereits ein höheres Timeout (60 s) für Chat und Arbeitsblatt-Erstellung.
- Große Bild-Uploads verlangsamen die Anfrage – für Hausaufgabenfotos reicht in der Regel eine normale Handyfoto-Auflösung, sehr große Dateien ggf. vorher verkleinern.
