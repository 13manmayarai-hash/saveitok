// netlify/functions/proxy.js
// Streams a remote video file through our own server so the user's browser never
// contacts the origin CDN directly. This bypasses geo-blocks like Douyin's zjcdn
// 403 (which blocks non-China IPs) — because the FETCH happens server-side.
//
// Called as: /api/proxy?url=<encoded video url>&name=<filename>
//
// NOTE: Netlify's free tier caps function execution at ~10s and has memory limits,
// so very large/long videos may fail. Short clips (typical TikTok/Douyin) work.

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

  const params = event.queryStringParameters || {};
  const target = params.url;
  const filename = (params.name || 'video.mp4').replace(/[^\w.\-]/g, '_');

  if (!target) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  // Only allow http(s) targets
  let parsed;
  try {
    parsed = new URL(target);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    return { statusCode: 400, body: 'Invalid url' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    // Fetch server-side. Send browser-like headers so CDNs don't reject us,
    // and a Referer that matches the platform where helpful.
    const upstream = await fetch(target, {
      method: 'GET',
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

    const arrayBuf = await upstream.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Allow-Origin': '*',
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
