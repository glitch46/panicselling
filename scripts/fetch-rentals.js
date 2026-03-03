const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RENTCAST_API_KEY;
if (!API_KEY) {
  console.error('RENTCAST_API_KEY environment variable is required');
  process.exit(1);
}

const API_URL = 'https://api.rentcast.io/v1/listings/rental/long-term?city=Austin&state=TX&limit=500';
const MEDIAN_CACHE_PATH = path.join(__dirname, '..', 'data', 'median-rents.json');
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadMedianCache() {
  try {
    return JSON.parse(fs.readFileSync(MEDIAN_CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMedianCache(cache) {
  fs.writeFileSync(MEDIAN_CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function apiFetch(url) {
  const resp = await fetch(url, {
    headers: { 'X-Api-Key': API_KEY, Accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function fetchListings() {
  return apiFetch(API_URL);
}

async function getMedianRent(zipCode, cache) {
  const now = Date.now();
  const cached = cache[zipCode];
  if (cached && (now - cached.fetchedAt) < CACHE_MAX_AGE_MS) {
    return cached.medianRent;
  }

  console.log(`  Fetching median rent for zip ${zipCode}...`);
  const data = await apiFetch(`https://api.rentcast.io/v1/markets?zipCode=${zipCode}`);

  // Extract median rent from market data
  let medianRent = null;
  if (data && data.rentData && data.rentData.averageRent != null) {
    medianRent = data.rentData.averageRent;
  } else if (data && data.medianRent != null) {
    medianRent = data.medianRent;
  } else if (Array.isArray(data) && data.length > 0) {
    const entry = data[0];
    medianRent = entry.rentData?.averageRent ?? entry.medianRent ?? null;
  }

  cache[zipCode] = { medianRent, fetchedAt: now };
  return medianRent;
}

async function main() {
  console.log('Fetching rental listings from RentCast...');
  const raw = await fetchListings();
  const listings = Array.isArray(raw) ? raw : (raw.listings || raw.data || []);

  // Filter to Active or New only
  const active = listings.filter(l => l.status === 'Active' || l.status === 'New');
  console.log(`Fetched ${listings.length} listings, ${active.length} Active/New`);

  // Collect unique zip codes
  const zips = [...new Set(active.map(l => l.zipCode).filter(Boolean))];
  console.log(`Found ${zips.length} unique zip codes`);

  // Fetch median rents (with cache)
  const cache = loadMedianCache();
  let medianLookups = 0;
  for (const zip of zips) {
    const wasCached = cache[zip] && (Date.now() - cache[zip].fetchedAt) < CACHE_MAX_AGE_MS;
    await getMedianRent(zip, cache);
    if (!wasCached) medianLookups++;
  }
  saveMedianCache(cache);
  console.log(`Median rent lookups: ${medianLookups} (${zips.length - medianLookups} cached)`);

  // Find hot deals: rent below median for the zip
  const deals = [];
  for (const listing of active) {
    const zip = listing.zipCode;
    if (!zip) continue;

    const rentPrice = listing.price;
    if (!rentPrice) continue;

    const medianRent = cache[zip]?.medianRent;
    if (!medianRent || medianRent <= 0) continue;

    if (rentPrice < medianRent) {
      const discountDollar = medianRent - rentPrice;
      const discountPercent = (discountDollar / medianRent) * 100;

      deals.push({
        address: listing.formattedAddress || listing.addressLine1 || 'Unknown',
        city: listing.city || 'Austin',
        state: listing.state || 'TX',
        zip,
        neighborhood: listing.county || listing.city || '',
        propertyType: listing.propertyType || 'Unknown',
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        sqft: listing.squareFootage,
        rentPrice,
        medianRent,
        discountDollar,
        discountPercent,
        status: listing.status,
        daysOnMarket: listing.daysOnMarket,
        listedDate: listing.listedDate || listing.createdDate,
      });
    }
  }

  // Sort by discount percent descending
  deals.sort((a, b) => b.discountPercent - a.discountPercent);
  console.log(`Found ${deals.length} hot deals (below median rent)`);

  const output = {
    generated: new Date().toISOString(),
    totalScanned: active.length,
    medianLookups,
    deals,
  };

  const outPath = path.join(__dirname, '..', 'data', 'rentals.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
