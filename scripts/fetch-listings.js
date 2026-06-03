const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RENTCAST_API_KEY;
if (!API_KEY) {
  console.error('RENTCAST_API_KEY environment variable is required');
  process.exit(1);
}

const API_URL = 'https://api.rentcast.io/v1/listings/sale?city=Austin&state=TX&status=Active&limit=500';
const ALLOWED_SOURCE_DOMAINS = ['realtor.com', 'zillow.com', 'redfin.com'];
const MIN_DROP_PERCENT = 2;
const MAX_DAYS_ON_MARKET = 730;
const DISPLAY_LIMIT = 100;

async function fetchListings() {
  const resp = await fetch(API_URL, {
    headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

function getHistoryEvents(listing) {
  if (!listing.history) return [];
  const events = Array.isArray(listing.history)
    ? listing.history
    : Object.entries(listing.history).map(([date, evt]) => ({ ...evt, date }));

  return events.sort((a, b) => new Date(b.date || b.listedDate || 0) - new Date(a.date || a.listedDate || 0));
}

function isStale(listing) {
  if (listing.status !== 'Active') return true;
  if (listing.removedDate) return true;
  if (listing.daysOnMarket > MAX_DAYS_ON_MARKET) return true;

  const events = getHistoryEvents(listing);
  if (events[0]?.removedDate) return true;

  return false;
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isAllowedListingDomain(hostname) {
  const host = String(hostname || '').toLowerCase();
  return ALLOWED_SOURCE_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function buildRealtorFallbackLink(listing) {
  if (!listing || typeof listing.id !== 'string' || !listing.id.trim()) return null;

  const city = String(listing.city || '').trim();
  const state = String(listing.state || '').trim();
  if (!city || !state) return null;

  const candidate = `https://www.realtor.com/realestateandhomes-detail/${listing.id}`;
  const parsed = normalizeUrl(candidate);
  if (!parsed) return null;
  return parsed.toString();
}

function getSourceLink(listing) {
  const candidates = [
    listing.sourceUrl,
    listing.sourceURL,
    listing.listingUrl,
    listing.url,
    listing.realtorUrl,
    listing.redfinUrl,
    listing.zillowUrl,
    listing.externalUrl,
    listing.permalink,
  ];

  for (const candidate of candidates) {
    const parsed = normalizeUrl(candidate);
    if (!parsed) continue;
    if (isAllowedListingDomain(parsed.hostname)) return parsed.toString();
  }

  return buildRealtorFallbackLink(listing);
}

function getMlsNumber(listing) {
  const candidates = [listing.mlsNumber, listing.mlsId, listing.mlsID, listing.mls];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const normalized = String(candidate).trim();
    if (normalized) return normalized;
  }
  return null;
}

function normalizeListing(listing, overrides = {}) {
  return {
    address: listing.formattedAddress || listing.addressLine1 || 'Unknown',
    city: listing.city || 'Austin',
    state: listing.state || 'TX',
    zip: listing.zipCode || '',
    neighborhood: listing.county || listing.city || '',
    propertyType: listing.propertyType || 'Unknown',
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    sqft: listing.squareFootage,
    currentPrice: listing.price,
    listedDate: listing.listedDate || listing.createdDate || null,
    daysOnMarket: listing.daysOnMarket,
    status: listing.status,
    mlsNumber: getMlsNumber(listing),
    sourceLink: getSourceLink(listing),
    latitude: listing.latitude || null,
    longitude: listing.longitude || null,
    ...overrides,
  };
}

function detectPriceDrop(listing) {
  const currentPrice = listing.price;
  if (!currentPrice) return null;

  const events = getHistoryEvents(listing);
  if (events.length < 2) return null;

  let highestOldPrice = null;
  let dropDate = null;

  for (let i = 1; i < events.length; i++) {
    const eventPrice = events[i].price;
    if (eventPrice && eventPrice > currentPrice) {
      if (!highestOldPrice || eventPrice > highestOldPrice) highestOldPrice = eventPrice;
      const eventDate = events[i].date || events[i].listedDate;
      if (eventDate && (!dropDate || new Date(eventDate) > new Date(dropDate))) dropDate = eventDate;
    }
  }

  if (!highestOldPrice || highestOldPrice <= currentPrice) return null;

  const dropDollar = highestOldPrice - currentPrice;
  const dropPercent = (dropDollar / highestOldPrice) * 100;
  if (dropPercent < MIN_DROP_PERCENT) return null;

  return normalizeListing(listing, {
    listingKind: 'drop',
    oldPrice: highestOldPrice,
    dropDollar,
    dropPercent,
    dropDate: dropDate || listing.lastSeenDate || listing.lastSeen || listing.listedDate || listing.createdDate || null,
  });
}

function buildSalesData(listings) {
  const drops = [];
  const activeListings = [];

  for (const listing of listings) {
    if (isStale(listing)) continue;
    if (!listing.price) continue;

    const drop = detectPriceDrop(listing);
    if (drop) drops.push(drop);

    activeListings.push(normalizeListing(listing, {
      listingKind: drop ? 'drop' : getHistoryEvents(listing).length > 1 ? 'active-no-drop' : 'active-no-history',
      oldPrice: drop?.oldPrice || null,
      dropDollar: drop?.dropDollar || 0,
      dropPercent: drop?.dropPercent || 0,
      dropDate: drop?.dropDate || null,
    }));
  }

  drops.sort((a, b) => b.dropDollar - a.dropDollar);

  const dropAddresses = new Set(drops.map(drop => drop.address));
  const fallbackListings = activeListings
    .filter(listing => !dropAddresses.has(listing.address))
    .sort((a, b) => {
      const dateDiff = new Date(b.listedDate || 0) - new Date(a.listedDate || 0);
      if (dateDiff !== 0) return dateDiff;
      return (a.currentPrice || 0) - (b.currentPrice || 0);
    });

  return {
    drops,
    activeListings,
    displayListings: [...drops, ...fallbackListings].slice(0, DISPLAY_LIMIT),
  };
}

async function main() {
  console.log('Fetching listings from RentCast...');
  const raw = await fetchListings();
  const listings = Array.isArray(raw) ? raw : (raw.listings || raw.data || []);

  console.log(`Fetched ${listings.length} listings`);

  const salesData = buildSalesData(listings);
  console.log(`Found ${salesData.drops.length} price drops over ${MIN_DROP_PERCENT}%`);
  console.log(`Kept ${salesData.activeListings.length} active listings after filters`);
  console.log(`Prepared ${salesData.displayListings.length} display listings`);

  const output = {
    generated: new Date().toISOString(),
    totalScanned: listings.length,
    filter: {
      minDropPercent: MIN_DROP_PERCENT,
      maxDaysOnMarket: MAX_DAYS_ON_MARKET,
      displayLimit: DISPLAY_LIMIT,
    },
    drops: salesData.drops,
    activeListings: salesData.activeListings,
    displayListings: salesData.displayListings,
  };

  const outPath = path.join(__dirname, '..', 'data', 'listings.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
