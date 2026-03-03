const fs = require('fs');
const path = require('path');

const API_KEY = process.env.RENTCAST_API_KEY;
if (!API_KEY) {
  console.error('RENTCAST_API_KEY environment variable is required');
  process.exit(1);
}

const API_URL = 'https://api.rentcast.io/v1/listings/sale?city=Austin&state=TX&status=Active&limit=500';

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

function isStale(listing) {
  if (listing.status !== 'Active') return true;
  if (listing.removedDate) return true;
  if (listing.daysOnMarket > 365) return true;

  if (!listing.history) return true;
  const events = Array.isArray(listing.history)
    ? listing.history
    : Object.entries(listing.history).map(([date, evt]) => ({ ...evt, date }));

  if (events.length < 2) return true;

  // Sort descending by date
  events.sort((a, b) => new Date(b.date || b.listedDate) - new Date(a.date || a.listedDate));
  const mostRecent = events[0];
  if (mostRecent.removedDate) return true;

  return false;
}

function detectPriceDrops(listings) {
  const drops = [];

  for (const listing of listings) {
    const currentPrice = listing.price;
    if (!currentPrice) continue;
    if (isStale(listing)) continue;

    const events = Array.isArray(listing.history)
      ? listing.history
      : Object.entries(listing.history).map(([date, evt]) => ({ ...evt, date }));

    // Sort events by date descending
    events.sort((a, b) => new Date(b.date || b.listedDate) - new Date(a.date || a.listedDate));

    // Find the highest price from older entries
    let highestOldPrice = null;
    let dropDate = null;

    for (let i = 1; i < events.length; i++) {
      const eventPrice = events[i].price;
      if (eventPrice && eventPrice > currentPrice) {
        if (!highestOldPrice || eventPrice > highestOldPrice) {
          highestOldPrice = eventPrice;
        }
        const eventDate = events[i].date || events[i].listedDate;
        if (eventDate && (!dropDate || new Date(eventDate) > new Date(dropDate))) {
          dropDate = eventDate;
        }
      }
    }

    if (highestOldPrice && highestOldPrice > currentPrice) {
      const finalDropDate = dropDate || listing.lastSeen || listing.createdDate;
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
      if (!finalDropDate || new Date(finalDropDate) < twelveMonthsAgo) continue;

      const dropDollar = highestOldPrice - currentPrice;
      const dropPercent = (dropDollar / highestOldPrice) * 100;

      drops.push({
        address: listing.formattedAddress || listing.addressLine1 || 'Unknown',
        city: listing.city || 'Austin',
        state: listing.state || 'TX',
        zip: listing.zipCode || '',
        neighborhood: listing.county || listing.city || '',
        propertyType: listing.propertyType || 'Unknown',
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        sqft: listing.squareFootage,
        currentPrice,
        oldPrice: highestOldPrice,
        dropDollar,
        dropPercent,
        dropDate: finalDropDate,
        daysOnMarket: listing.daysOnMarket,
        status: listing.status,
      });
    }
  }

  // Sort by biggest dollar drop
  drops.sort((a, b) => b.dropDollar - a.dropDollar);
  return drops;
}

async function main() {
  console.log('Fetching listings from RentCast...');
  const raw = await fetchListings();
  const listings = Array.isArray(raw) ? raw : (raw.listings || raw.data || []);

  console.log(`Fetched ${listings.length} listings`);

  const drops = detectPriceDrops(listings);
  console.log(`Found ${drops.length} price drops (after filtering stale listings)`);

  const output = {
    generated: new Date().toISOString(),
    totalScanned: listings.length,
    drops,
  };

  const outPath = path.join(__dirname, '..', 'data', 'listings.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
