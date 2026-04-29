import { createClient } from '@supabase/supabase-js';
import { chromium, Page } from 'playwright';
import { tagTender } from './cpv_registry.js';
import pLimit from 'p-limit';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BASE_URL = 'https://www.find-tender.service.gov.uk';
const LIST_URL = `${BASE_URL}/Search/Results?status=Open`;
const CONCURRENCY = 3;
const TIMEOUT = 30000;

function parseDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function extractValue(text: string): number | null {
  if (!text) return null;
  const m = text.match(/£\s?([\d,]+(?:\.\d+)?)\s?(m|million)?|([\d,]+)\s?GBP/i);
  if (!m) return null;
  let num = parseFloat((m[1] || m[3]).replace(/,/g, ''));
  if (m[2]) num *= 1_000_000;
  return Math.round(num);
}

function extractCPV(text: string): string[] {
  const matches = text.match(/\b\d{8}\b/g);
  return matches ? [...new Set(matches)] : [];
}

async function safeGoto(page: Page, url: string) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      return;
    } catch (e) {
      if (i === 2) throw e;
      await page.waitForTimeout(1000 * (i + 1));
    }
  }
}

async function scrapeFindTender() {
  const start = Date.now();
  console.log('=== FT SCRAPER START ===', new Date().toISOString());

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; TenderEdgeBot/1.0; +https://tenderedge.ai)'
  });
  const page = await context.newPage();

  await safeGoto(page, LIST_URL);
  await page.waitForSelector('.search-result', { timeout: 15000 }).catch(() => {});

  const listResults = await page.$$eval('.search-result', nodes =>
    nodes.map(n => {
      const titleEl = n.querySelector('h2 a') as HTMLAnchorElement;
      const buyerEl = n.querySelector('.search-result-sub-header');
      const descEl = n.querySelector('.search-result-description');
      const deadlineEl = n.querySelector('.search-result-deadline');

      return {
        title: titleEl?.textContent?.trim() || '',
        url: titleEl?.href || '',
        buyer: buyerEl?.textContent?.trim() || '',
        description: descEl?.textContent?.trim() || '',
        deadline_raw: deadlineEl?.textContent?.trim() || '',
        source: 'find-tender',
        status: 'open',
        scraped_at: new Date().toISOString()
      };
    })
  ).catch(() => []);

  console.log(`FT List results: ${listResults.length}`);
  if (!listResults.length) {
    await browser.close();
    console.log('PIPELINE STOPPED: No rows found');
    return;
  }

  const limit = pLimit(CONCURRENCY);
  const detailPage = await context.newPage();

  const enriched = await Promise.all(
    listResults.filter(r => r.url).map(r =>
      limit(async () => {
        try {
          await safeGoto(detailPage, r.url);
          const detailData = await detailPage.evaluate(() => {
            const getText = (sel: string) =>
              document.querySelector(sel)?.textContent?.trim() || '';
            return {
              full_text: document.body.innerText,
              cpv: getText('td:has-text("CPV") + td'),
              value: getText('td:has-text("Value") + td')
            };
          });

          return {
            ...r,
            description: r.description || detailData.full_text.slice(0, 2000),
            cpv_raw: detailData.cpv,
            value_raw: detailData.value
          };
        } catch (e: any) {
          console.log('Detail fail:', r.url, e.message);
          return r;
        }
      })
    )
  );

  await browser.close();

  const cleaned = enriched
    .filter(r => r.title && r.url)
    .map(r => ({
      ...r,
      deadline: parseDate(r.deadline_raw),
      value: extractValue(r.value_raw),
      cpv_codes: extractCPV(r.cpv_raw || ''),
      source: 'find-tender',
      status: 'open'
    }))
    .map(r => tagTender(r));

  console.log(`FT Cleaned records: ${cleaned.length}`);

  if (cleaned.length) {
    const { error } = await supabase
      .from('tenders')
      .upsert(cleaned, { onConflict: 'url' });
    if (error) console.error('Supabase upsert error:', error.message);
    else console.log(`FT Upserted ${cleaned.length} records`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`=== FT SCRAPER DONE in ${elapsed}s ===`);
}

scrapeFindTender().catch(err => {
  console.error('FT scraper fatal error:', err);
  process.exit(1);
});
