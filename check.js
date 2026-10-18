const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.etermin.net/psychotherapie-oberkassel/serviceid/534814';
// Nur Termine VOR diesem Datum melden (Format JJJJ-MM-TT)
const CUTOFF = process.env.CUTOFF || '2028-12-31';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function notify(title, message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram-Secrets fehlen. Nachricht waere:', message);
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `🔔 ${title}\n\n${message}\n\n${URL}`,
      }),
    }
  );
  if (!res.ok) {
    console.error('Telegram-Fehler:', res.status, await res.text());
  }
}

// Sucht rekursiv alle Datumsangaben (JJJJ-MM-TT) in einer JSON-Antwort
function collectDates(node, out) {
  if (typeof node === 'string') {
    const m = node.match(/\b20\d{2}-\d{2}-\d{2}\b/);
    if (m) out.push(m[0]);
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

(async () => {
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

  // Alle JSON-Antworten von eTermin mitschneiden
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!url.includes('etermin.net')) return;
      if (!(res.headers()['content-type'] || '').includes('json')) return;
      apiLog.push(`${res.status()} ${url}`);
      const path = new globalThis.URL(url).pathname;
      if (/slot|avail|free|calendar/i.test(path)) {
        const data = await res.json();
        fs.writeFileSync(`debug/antwort-${apiLog.length}.json`, JSON.stringify(data, null, 2));
        collectDates(data, foundDates);
      }
    } catch {
      /* ignorieren */
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle' });

  // Cookie-Banner: nur essentielle Cookies
  await clickIfPresent(page, 'Anpassen');
  await clickIfPresent(page, 'Auswahl bestätigen');
  // Zur Terminauswahl, falls noetig
  await clickIfPresent(page, 'Weiter zur Terminauswahl');
  await page.waitForTimeout(8000);

  // Diagnose-Material speichern
  await page.screenshot({ path: 'debug/screenshot.png', fullPage: true });
  fs.writeFileSync('debug/seite.html', await page.content());
  fs.writeFileSync('debug/api-aufrufe.txt', apiLog.join('\n'));

  const today = new Date().toISOString().slice(0, 10);
  const dates = [...new Set(foundDates)].filter((d) => d > today).sort();
  const early = dates.filter((d) => d < CUTOFF);

  console.log('Gefundene Datumsangaben:', dates.slice(0, 20));
  console.log('Frueher als', CUTOFF, ':', early);

  if (early.length > 0) {
    await notify(
      'Termin frei!',
      `Freie Termine gefunden, frühester: ${early[0]}. Jetzt schnell buchen!`
    );
  }

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
