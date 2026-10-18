const { chromium } = require('playwright');
const fs = require('fs');

const DEFAULT_URL = 'https://www.etermin.net/psychotherapie-oberkassel/serviceid/534814';
const PAGE_URL = process.env.URL_OVERRIDE || DEFAULT_URL;
const CUTOFF = process.env.CUTOFF || '2099-12-31';
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

async function notify(title, message) {
  if (!TOKEN || !CHAT) {
    console.log('Telegram-Secrets fehlen. Nachricht waere:', message);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT,
      text: `🔔 ${title}\n\n${message}\n\n${PAGE_URL}`,
    }),
  });
  if (!res.ok) console.error('Telegram-Fehler:', res.status, await res.text());
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Findet Datumsangaben in verschiedenen Formaten und gibt sie als JJJJ-MM-TT zurueck
function collectDates(node, out) {
  if (typeof node === 'string') {
    let m = node.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
    if (m) out.push(`${m[1]}-${m[2]}-${m[3]}`);
    m = node.match(/\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/);
    if (m) out.push(`${m[3]}-${pad(m[2])}-${pad(m[1])}`);
    m = node.match(/\/Date\((\d{10,13})/);
    if (m) out.push(new Date(Number(m[1])).toISOString().slice(0, 10));
  } else if (Array.isArray(node)) {
    node.forEach((n) => collectDates(n, out));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach((n) => collectDates(n, out));
  }
}

async function clickIfPresent(page, text) {
  try {
    await page.getByText(text).first().click({ timeout: 4000 });
    await page.waitForTimeout(1500);
    return true;
  } catch {
    return false;
  }
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

(async () => {
  // Testmodus: nur Telegram pruefen
  if (process.env.TEST_NOTIFY === '1') {
    await notify('Test erfolgreich', 'Die Telegram-Benachrichtigung funktioniert.');
    summary('### Telegram-Test gesendet');
    return;
  }

  fs.mkdirSync('debug', { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    viewport: { width: 1280, height: 1800 },
  });
  const page = await context.newPage();

  const apiLog = [];
  const foundDates = [];
  let slotCalls = 0;

  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!url.includes('/api/timeslots')) return;
      slotCalls++;
      const body = await res.text();
      apiLog.push(`${res.status()} ${url}`);
      fs.writeFileSync(`debug/timeslots-${slotCalls}.txt`, body);
      summary(`**timeslots #${slotCalls}:** \`${body.slice(0, 300).replace(/`/g, "'")}\``);
      try {
        collectDates(JSON.parse(body), foundDates);
      } catch {
        collectDates(body, foundDates);
      }
    } catch {
      /* ignorieren */
    }
  });

  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await clickIfPresent(page, 'Anpassen');
  await clickIfPresent(page, 'Auswahl bestätigen');
  await clickIfPresent(page, 'Weiter zur Terminauswahl');
  await page.waitForTimeout(8000);

  await page.screenshot({ path: 'debug/screenshot.png', fullPage: true });
  fs.writeFileSync('debug/seite.html', await page.content());
  fs.writeFileSync('debug/api-aufrufe.txt', apiLog.join('\n'));

  // Signal 1: zukuenftige Datumsangaben in den Terminantworten
  const today = new Date().toISOString().slice(0, 10);
  const dates = [...new Set(foundDates)].filter((d) => d > today).sort();
  const early = dates.filter((d) => d < CUTOFF);

  // Signal 2: der Satz "keine Termine verfuegbar" ist weg, obwohl die Seite geladen ist
  const loaded = await page
    .getByText('Tag & Uhrzeit wählen')
    .first()
    .isVisible()
    .catch(() => false);
  const noSlotsMsg = await page
    .getByText('keine Termine')
    .first()
    .isVisible()
    .catch(() => false);
  const uiSignal = loaded && !noSlotsMsg;

  console.log('Seite geladen:', loaded, '| "keine Termine"-Hinweis sichtbar:', noSlotsMsg);
  console.log('Gefundene Datumsangaben:', dates.slice(0, 20));
  summary(
    `### Ergebnis\n- Seite geladen: ${loaded}\n- Hinweis "keine Termine" sichtbar: ${noSlotsMsg}\n` +
      `- Zukünftige Daten in Antworten: ${dates.slice(0, 20).join(', ') || 'keine'}\n` +
      `- timeslots-Aufrufe: ${slotCalls}`
  );

  if (early.length > 0) {
    await notify('Termin frei!', `Freie Termine gefunden, frühester: ${early[0]}. Jetzt schnell buchen!`);
  } else if (uiSignal) {
    await notify(
      'Möglicherweise Termin frei!',
      'Der Hinweis "keine Termine verfügbar" ist verschwunden. Bitte sofort die Seite prüfen.'
    );
  }

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
