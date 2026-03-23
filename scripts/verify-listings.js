const fs = require('fs');
const path = require('path');

const INPUT_PATH = path.join(__dirname, '..', 'data', 'listings.json');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'listings-verification.json');
const ALLOWED_SOURCE_DOMAINS = ['realtor.com', 'zillow.com', 'redfin.com'];
const REQUEST_TIMEOUT_MS = 15000;
const MAX_BODY_CHARS = 400000;
const CONCURRENCY = 5;

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const full = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(full);
  } catch {
    return null;
  }
}

function isAllowedListingDomain(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_SOURCE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function normalizeMls(value) {
  if (value == null) return '';
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeStreet(value) {
  if (!value) return '';
  const streetOnly = String(value).split(',')[0] || '';
  return streetOnly.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  return fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; PanicSellingVerifier/1.0)',
      Accept: 'text/html,application/xhtml+xml',
    },
  }).finally(() => clearTimeout(timeout));
}

async function verifyListing(listing) {
  const sourceLink = listing.sourceLink;
  const mlsNumber = listing.mlsNumber;

  if (!sourceLink) return { ok: false, reason: 'missing sourceLink', stage: 'input' };
  if (!mlsNumber) return { ok: false, reason: 'missing mlsNumber', stage: 'input' };

  const parsed = normalizeUrl(sourceLink);
  if (!parsed) return { ok: false, reason: 'invalid sourceLink URL', stage: 'input' };
  if (!isAllowedListingDomain(parsed.hostname)) {
    return { ok: false, reason: `sourceLink domain not allowed: ${parsed.hostname}`, stage: 'input' };
  }

  let resp;
  try {
    resp = await fetchWithTimeout(parsed.toString());
  } catch (err) {
    return { ok: false, reason: `request failed: ${err.message}`, stage: 'request' };
  }

  if (!resp.ok) {
    return { ok: false, reason: `http status ${resp.status}`, stage: 'request', statusCode: resp.status };
  }

  const finalUrl = normalizeUrl(resp.url || parsed.toString());
  if (!finalUrl || !isAllowedListingDomain(finalUrl.hostname)) {
    return {
      ok: false,
      reason: 'redirected to non-allowed domain',
      stage: 'request',
      finalUrl: resp.url || null,
    };
  }

  const contentType = String(resp.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return {
      ok: false,
      reason: `unexpected content-type ${contentType || 'unknown'}`,
      stage: 'content',
      finalUrl: finalUrl.toString(),
    };
  }

  let body;
  try {
    body = await resp.text();
  } catch (err) {
    return { ok: false, reason: `failed to read response body: ${err.message}`, stage: 'content' };
  }

  const bodySlice = body.slice(0, MAX_BODY_CHARS);
  const bodyNormalizedAlphaNum = bodySlice.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bodyNormalizedText = bodySlice.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  const normalizedMls = normalizeMls(mlsNumber);
  const normalizedStreet = normalizeStreet(listing.address);

  const hasMls = normalizedMls ? bodyNormalizedAlphaNum.includes(normalizedMls) : false;
  const hasStreet = normalizedStreet ? bodyNormalizedText.includes(normalizedStreet) : false;

  if (!hasMls && !hasStreet) {
    return {
      ok: false,
      reason: 'page content did not match MLS or address',
      stage: 'match',
      finalUrl: finalUrl.toString(),
      match: { mls: hasMls, address: hasStreet },
    };
  }

  return {
    ok: true,
    normalizedSourceLink: finalUrl.toString(),
    matchedBy: hasMls ? 'mls' : 'address',
    match: { mls: hasMls, address: hasStreet },
  };
}

async function runWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  async function next() {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await next();
  }

  const runners = [];
  const count = Math.min(concurrency, items.length);
  for (let i = 0; i < count; i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

async function main() {
  const input = JSON.parse(fs.readFileSync(INPUT_PATH, 'utf-8'));
  const drops = Array.isArray(input.drops) ? input.drops : [];

  console.log(`Verifying ${drops.length} listings...`);

  const outcomes = await runWithConcurrency(
    drops,
    async (listing, idx) => {
      const result = await verifyListing(listing);
      const label = `${idx + 1}/${drops.length}`;
      if (result.ok) {
        console.log(`${label} OK ${listing.address} (${result.matchedBy})`);
      } else {
        console.log(`${label} FAIL ${listing.address}: ${result.reason}`);
      }
      return { listing, result };
    },
    CONCURRENCY
  );

  const verified = [];
  const rejected = [];

  for (const outcome of outcomes) {
    if (outcome.result.ok) {
      verified.push({
        ...outcome.listing,
        sourceLink: outcome.result.normalizedSourceLink || outcome.listing.sourceLink,
      });
    } else {
      rejected.push({
        address: outcome.listing.address,
        mlsNumber: outcome.listing.mlsNumber,
        sourceLink: outcome.listing.sourceLink,
        reason: outcome.result.reason,
        stage: outcome.result.stage || null,
        statusCode: outcome.result.statusCode || null,
        finalUrl: outcome.result.finalUrl || null,
        match: outcome.result.match || null,
      });
    }
  }

  const output = {
    ...input,
    verifiedAt: new Date().toISOString(),
    verification: {
      checked: drops.length,
      passed: verified.length,
      rejected: rejected.length,
    },
    drops: verified,
  };

  fs.writeFileSync(INPUT_PATH, JSON.stringify(output, null, 2));
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        checked: drops.length,
        passed: verified.length,
        rejected: rejected.length,
        rejectedListings: rejected,
      },
      null,
      2
    )
  );

  console.log(`Verified listings written to ${INPUT_PATH}`);
  console.log(`Verification report written to ${REPORT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
