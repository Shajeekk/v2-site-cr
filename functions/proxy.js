export async function onRequest(context) {
  const { request, env } = context;

  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type,Authorization',
    'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Range,Content-Length'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const which = (url.searchParams.get('which') || 'sky').toLowerCase();
  const uParam = url.searchParams.get('u');

  const MAP = {
    sky: env.SKY_URL || 'https://example.com/your-sky-stream.m3u8',
    willow: env.WILLOW_URL || 'https://example.com/your-willow-stream.m3u8'
  };

  // Determine target URL: either explicit `u` passthrough (for segments/sub-playlists) or top-level mapped URL
  const targetUrl = uParam ? uParam : MAP[which];
  if (!targetUrl) {
    return new Response('Stream not found', { status: 404, headers: CORS_HEADERS });
  }

  // Forward critical headers
  const forwardHeaders = new Headers();
  const range = request.headers.get('range');
  if (range) forwardHeaders.set('range', range);
  const accept = request.headers.get('accept');
  if (accept) forwardHeaders.set('accept', accept);
  const ua = request.headers.get('user-agent');
  if (ua) forwardHeaders.set('user-agent', ua);

  let originRes;
  try {
    originRes = await fetch(targetUrl, { method: 'GET', headers: forwardHeaders, redirect: 'follow' });
  } catch (err) {
    return new Response('Upstream fetch failed: ' + err.message, { status: 502, headers: CORS_HEADERS });
  }

  // If not an HLS playlist, stream through (segments, keys, etc.)
  const contentType = originRes.headers.get('content-type') || '';
  const isPlaylist = /application\/vnd\.apple\.mpegurl|application\/x-mpegURL|audio\/mpegurl|vnd\.apple\.mpegurl|\.m3u8(?!\w)/i.test(contentType) || /\.m3u8(\?|$)/i.test(targetUrl);

  if (!isPlaylist) {
    const passthroughHeaders = new Headers(originRes.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => passthroughHeaders.set(k, v));
    return new Response(originRes.body, { status: originRes.status, statusText: originRes.statusText, headers: passthroughHeaders });
  }

  // Rewrite playlist so all URIs go back through this proxy with the same `which` value
  const base = new URL(targetUrl);
  const text = await originRes.text();

  const rewritten = text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    // Keep comments/tags and blank lines
    if (trimmed === '' || trimmed.startsWith('#')) return line;
    // Resolve relative URI against base and rebuild as proxied URL
    let resolved;
    try {
      resolved = new URL(trimmed, base).toString();
    } catch (_) {
      // If unparsable, keep as-is
      return line;
    }
    const proxied = `/proxy?which=${encodeURIComponent(which)}&u=${encodeURIComponent(resolved)}`;
    return proxied;
  }).join('\n');

  const headers = new Headers(originRes.headers);
  // Content length no longer valid after rewrite
  headers.delete('content-length');
  headers.set('content-type', 'application/vnd.apple.mpegurl');
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  return new Response(rewritten, { status: 200, headers });
}
