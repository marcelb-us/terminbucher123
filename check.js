const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://www.etermin.net/psychotherapie-oberkassel/serviceid/534814';
// Nur Termine VOR diesem Datum melden (Format JJJJ-MM-TT)
const CUTOFF = process.env.CUTOFF || '2028-12-31';
const NTFY_TOPIC = process.env.NTFY_TOPIC;

async function notify(title, message) {
  if (!NTFY_TOPIC) {
    console.log('Kein NTFY_TOPIC gesetzt. Nachricht waere:', message);
    return;
  }
  await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Priority: 'urgent', Tags: 'calendar', Click: URL },
    body: message,
  });
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
