// netlify/functions/proxy.js
// Streams a remote video file through our own server so the user's browser never
// contacts the origin CDN directly. This bypasses geo-blocks (e.g. Douyin's zjcdn
// 403 for non-China IPs) because the fetch happens server-side.
//
// Called as: /api/proxy?url=<encoded video url>&name=<filename>
//
// SECURITY: This is NOT an open proxy. It only fetches URLs whose host ends with
// a known video-CDN domain (allowlist below), and it blocks private/internal
// addresses to prevent SSRF. Requests to anything else are rejected.
//
// NOTE: Netlify's free tier caps function execution at ~10s with memory limits,
// so very large/long videos may fail. Short clips (typical TikTok/Douyin) work.

// Hosts we allow proxying from — the CDNs the download API actually returns.
// Suffix match, so "v39e-as.tiktokcdn.com" matches "tiktokcdn.com".
const ALLOWED_HOST_SUFFIXES = [
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokv.com',
  'ttwstatic.com',
  'muscdn.com',
  'byteoversea.com',
  'zjcdn.com',        // Douyin
  'douyinpic.com',
  'douyinvod.com',
  'amemv.com',
  'cdninstagram.com', // Instagram
  'fbcdn.net',        // Instagram/Facebook
  'xx.fbcdn.net',
  'fbcdn.com',
];

// Block obviously-internal / private targets (SSRF hardening).
function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv4 literal checks
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1]), parseInt(m[2])];
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // loopback
    if (a === 169 && b === 254) return true;           // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 0) return true;
  }
  if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80')) return true;
  return false;
}

function hostAllowed(host) {
  const h = host.toLowerCase().replace(/:\d+$/, ''); // strip port
  if (isPrivateHost(h)) return false;
  return ALLOWED_HOST_SUFFIXES.some(suf => h === suf || h.endsWith('.' + suf));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params = event.queryStringParameters || {};
  const target = params.url;
  const filename = (params.name || 'video.mp4').replace(/[^\w.\-]/g, '_').slice(0, 80);

  if (!target) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  // Validate protocol + host allowlist (blocks SSRF + open-proxy abuse)
  let parsed;
  try {
    parsed = new URL(target);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    return { statusCode: 400, body: 'Invalid url' };
  }
  if (!hostAllowed(parsed.hostname)) {
    return { statusCode: 403, body: 'This URL is not allowed.' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    const upstream = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': '*/*',
        'Referer': `${parsed.protocol}//${parsed.host}/`
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!upstream.ok) {
      return { statusCode: 502, body: `Upstream returned ${upstream.status}` };
    }

    // Cap response size to protect the function (base64 in memory).
    // ~9 MB raw → ~12 MB base64, safely under Netlify's response limit.
    const MAX_BYTES = 9 * 1024 * 1024;
    const lenHeader = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (lenHeader && lenHeader > MAX_BYTES) {
      return { statusCode: 413, body: 'Video is too large to proxy on this server. Try a shorter clip.' };
    }

    const arrayBuf = await upstream.arrayBuffer();
    if (arrayBuf.byteLength > MAX_BYTES) {
      return { statusCode: 413, body: 'Video is too large to proxy on this server. Try a shorter clip.' };
    }

    const buf = Buffer.from(arrayBuf);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    return {
      statusCode: e.name === 'AbortError' ? 504 : 502,
      body: e.name === 'AbortError'
        ? 'Timed out fetching the video (it may be too large for the free tier).'
        : 'Could not fetch the video.'
    };
  }
};
