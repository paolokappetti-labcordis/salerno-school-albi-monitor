import { chromium } from "playwright";
import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const SOURCES_PATH = "school-albi-sources.json";
const STATE_PATH = "school-albi-state.json";
const RECIPIENT = process.env.EMAIL_RECIPIENT || process.env.GMAIL_USERNAME;
const CONCURRENCY = 6;

const primaryPattern = /\b(band[oi]|avvis[oi]|selezion\w*|manifestazion\w*|interpello\w*|reclutament\w*|incaric\w*|candidat\w*|graduator\w*)\b/i;
const subjectPattern = /\b(cors[oi]|formazion\w*|formator\w*|espert\w*|tutor\w*|mentor\w*|docent\w*|pnrr|pon|d\.?m\.?\s*(65|66)|stem|linguistic\w*|orientament\w*|competenz\w*)\b/i;

const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
const normalizeUrl = (value = "") => {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
};
const itemKey = (item) =>
  createHash("sha256")
    .update([item.source, normalizeUrl(item.url), normalize(item.title).toLowerCase()].join("\n"))
    .digest("hex");

const config = JSON.parse(await readFile(SOURCES_PATH, "utf8"));
if (!Array.isArray(config.boards) || config.boards.length === 0) {
  throw new Error("Nessun albo configurato.");
}

let state = { known_keys: [] };
try {
  state = JSON.parse(await readFile(STATE_PATH, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const isBaseline = !Array.isArray(state.known_keys) || state.known_keys.length === 0;
const known = new Set(state.known_keys || []);

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
});
const context = await browser.newContext({
  locale: "it-IT",
  timezoneId: "Europe/Rome",
  ignoreHTTPSErrors: true,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
});

async function extractFromFrame(frame, sourceUrl) {
  try {
    return await frame.locator("a[href]").evaluateAll((anchors, source) => {
      const clean = (value = "") => value.replace(/\s+/g, " ").trim();
      return anchors
        .map((anchor) => {
          const container =
            anchor.closest("article, tr, li, [class*='card'], [class*='item'], [class*='record'], [class*='document']") ||
            anchor.parentElement;
          const title = clean(anchor.textContent || anchor.getAttribute("title") || "");
          const context = clean(container?.textContent || "").slice(0, 800);
          return {
            title,
            context,
            url: anchor.href || "",
            source,
          };
        })
        .filter((item) => item.title && item.url);
    }, sourceUrl);
  } catch {
    return [];
  }
}

async function scanBoard(board) {
  const page = await context.newPage();
  try {
    await page.goto(board.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const raw = [];
    for (const frame of page.frames()) {
      raw.push(...(await extractFromFrame(frame, board.url)));
    }
    const seen = new Set();
    const items = [];
    for (const item of raw) {
      const title = normalize(item.title);
      const combined = normalize(title + " " + item.context);
      const url = normalizeUrl(item.url);
      if (!primaryPattern.test(combined) || !subjectPattern.test(combined)) continue;
      if (!/^https?:/i.test(url) || url === normalizeUrl(board.url)) continue;
      const signature = title.toLowerCase() + "\n" + url;
      if (seen.has(signature)) continue;
      seen.add(signature);
      const date =
        combined.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/)?.[0] ||
        combined.match(/\b\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+\d{4}\b/i)?.[0] ||
        "";
      items.push({
        title: title.slice(0, 300),
        date,
        url,
        source: board.url,
        schools: board.schools || [],
      });
      if (items.length >= 250) break;
    }
    console.log(`OK ${board.url}: ${items.length} pubblicazioni pertinenti`);
    return { ok: true, items };
  } catch (error) {
    console.warn(`ERRORE ${board.url}: ${error.message}`);
    return { ok: false, items: [], error: error.message };
  } finally {
    await page.close();
  }
}

const results = new Array(config.boards.length);
let cursor = 0;
async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= config.boards.length) return;
    results[index] = await scanBoard(config.boards[index]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await browser.close();

const successful = results.filter((result) => result?.ok).length;
if (successful < Math.ceil(config.boards.length * 0.5)) {
  throw new Error(`Troppi albi non raggiungibili: ${successful}/${config.boards.length}. Stato non aggiornato.`);
}

const currentItems = results.flatMap((result) => result?.items || []);
const uniqueCurrent = new Map();
for (const item of currentItems) {
  const key = itemKey(item);
  if (!uniqueCurrent.has(key)) uniqueCurrent.set(key, { ...item, key });
}
const newItems = [...uniqueCurrent.values()].filter((item) => !known.has(item.key));

const updatedKeys = [...new Set([...uniqueCurrent.keys(), ...known])].slice(0, 20_000);
await writeFile(
  STATE_PATH,
  JSON.stringify(
    {
      updated_at: new Date().toISOString(),
      boards_total: config.boards.length,
      boards_successful: successful,
      known_keys: updatedKeys,
    },
    null,
    2
  ) + "\n"
);

if (isBaseline) {
  console.log(`Baseline creata con ${uniqueCurrent.size} pubblicazioni pertinenti; nessuna email inviata.`);
  process.exit(0);
}
if (newItems.length === 0) {
  console.log(`Nessun nuovo bando pertinente. Albi controllati: ${successful}/${config.boards.length}.`);
  process.exit(0);
}

const username = process.env.GMAIL_USERNAME;
const appPassword = process.env.GMAIL_APP_PASSWORD;
if (!username || !appPassword) {
  throw new Error("Configura i secrets GMAIL_USERNAME e GMAIL_APP_PASSWORD.");
}

const sorted = newItems.sort((a, b) => a.title.localeCompare(b.title, "it"));
const body = [
  "Messaggio inviato da Paolo Kappetti per il Bollettino GPS.",
  "",
  `Sono stati rilevati ${sorted.length} nuovi bandi o avvisi relativi a corsi, formazione, esperti, formatori o tutor nelle scuole della provincia di Salerno.`,
  "",
  ...sorted.flatMap((item, index) => {
    const schools = (item.schools || [])
      .map((school) => `${school.name} (${school.code}) - ${school.city}`)
      .join("; ");
    return [
      `${index + 1}. ${item.title}`,
      `Scuola: ${schools || "non identificata"}`,
      `Data: ${item.date || "non indicata"}`,
      `Link: ${item.url}`,
      `Albo: ${item.source}`,
      "",
    ];
  }),
].join("\n");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: username, pass: appPassword },
});
await transporter.sendMail({
  from: `"Paolo Kappetti - Bollettino GPS" <${username}>`,
  to: RECIPIENT,
  subject: `🔔 ${sorted.length} nuovi bandi/corsi - scuole Salerno`,
  text: body,
});
console.log(`Email inviata per ${sorted.length} nuove pubblicazioni.`);
