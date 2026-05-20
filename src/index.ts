import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { tagTender } from './cpv_registry.js';
import pLimit from 'p-limit';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BASE_URL = 'https://www.find-tender.service.gov.uk';
const LIST_URL = `${BASE_URL}/Search/Results?status=Open`;
const CONCURRENCY = 3;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; TenderEdgeBot/1.0; +https://tenderedge.ai)'
};

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

async function fetchHtml(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return '';
}

async function scrapeFindTender() {
  const start = Date.now();
  console.log('=== FT SCRAPER START ===', new Date().toISOString());

  const listHtml = await fetchHtml(LIST_URL);
  const $list = cheerio.load(listHtml);

  const listResults: Array<{
    title: string;
    url: string;
    buyer: string;
    description: string;
    deadline_raw: string;
    source: string;
    status: string;
    scraped_at: string;
  }> = [];

  $list('.search-result').each((_i, el) => {
    const titleEl = $list(el).find('h2 a');
    const href = titleEl.attr('href') || '';
    listResults.push({
      title: titleEl.text().trim(),
      url: href.startsWith('http') ? href : `${BASE_URL}${href}`,
      buyer: $list(el).find('.search-result-sub-header').text().trim(),
      description: $list(el).find('.search-result-description').text().trim(),
      deadline_raw: $list(el).find('.search-result-deadline').text().trim(),
      source: 'find-tender',
      status: 'open',
      scraped_at: new Date().toISOString()
    });
  });

  console.log(`FT List results: ${listResults.length}`);
  if (!listResults.length) {
    console.log('PIPELINE STOPPED: No rows found');
    return;
  }

  const limit = pLimit(CONCURRENCY);

  const enriched = await Promise.all(
    listResults.filter(r => r.url).map(r =>
      limit(async () => {
        try {
          const detailHtml = await fetchHtml(r.url);
          const $d = cheerio.load(detailHtml);

          // Extract CPV: look for a table cell labelled "CPV" and grab the next cell
          let cpv = '';
          $d('td').each((_i, el) => {
            if ($d(el).text().trim().toUpperCase().includes('CPV')) {
              cpv = $d(el).next('td').text().trim();
              return false; // break
            }
          });

          // Extract value: look for a table cell labelled "Value" and grab the next cell
          let value = '';
          $d('td').each((_i, el) => {
            if ($d(el).text().trim().toUpperCase() === 'VALUE') {
              value = $d(el).next('td').text().trim();
              return false; // break
            }
          });

          const fullText = $d('body').text();

          return {
            ...r,
            description: r.description || fullText.slice(0, 2000),
            cpv_raw: cpv,
            value_raw: value
          };
        } catch (e: any) {
          console.log('Detail fail:', r.url, e.message);
          return { ...r, cpv_raw: '', value_raw: '' };
        }
      })
    )
  );

  const cleaned = enriched
    .filter(r => r.title && r.url)
    .map(r => ({
      ...r,
      deadline: parseDate(r.deadline_raw),
      value: extractValue(r.value_raw ?? ''),
      cpv_codes: extractCPV(r.cpv_raw ?? ''),
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
