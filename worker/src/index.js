const ALLOWED_ORIGINS = [
  'https://glitch46.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Forward query params to RentCast
    const url = new URL(request.url);
    const rentcastUrl = `https://api.rentcast.io/v1/listings/sale${url.search}`;

    const resp = await fetch(rentcastUrl, {
      headers: {
        'X-Api-Key': env.RENTCAST_API_KEY,
        'Accept': 'application/json',
      },
    });

    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin),
      },
    });
  },
};
