// netlify/functions/download.js
// Server-side proxy → ZM API (https://api.zm.io.vn)
// Covers TikTok, Douyin, Instagram, Facebook and more, watermark-free.
// The browser calls /api/download (same origin, no CORS). This function calls
// ZM API server-to-server with the API key kept in a Netlify environment variable.
//
// Netlify environment variable required:
//   ZM_API_KEY = your key from https://zm.io.vn/get-key

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function respond(statusCode, data) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

// Human-friendly labels for ZM's quality strings
function labelFor(quality) {
  switch ((quality || '').toLowerCase()) {
    case 'hd_no_watermark': return 'HD · No watermark';
    case 'no_watermark':    return 'SD · No watermark';
    case 'watermark':       return 'With watermark';
    case 'audio':           return 'Audio (MP3)';
    default:                return quality || 'Video';
  }
}

// Rank video qualities best-first
function rank(quality) {
  switch ((quality || '').toLowerCase()) {
    case 'hd_no_watermark': return 0;
    case 'no_watermark':    return 1;
    case 'watermark':       return 2;
    default:                return 3;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { status: 'error', text: 'Method not allowed' });
  }

  const API_KEY = process.env.ZM_API_KEY;
  if (!API_KEY) {
    return respond(503, { status: 'error', text: 'Downloader is being set up. Please try again shortly.' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return respond(400, { status: 'error', text: 'Invalid request' });
  }

  const { url, quality, isAudioOnly } = body;
  if (!url || typeof url !== 'string') {
    return respond(400, { status: 'error', text: 'Please paste a video URL.' });
  }
  if (url.length > 2048) {
    return respond(400, { status: 'error', text: 'That URL is too long.' });
  }
  // Must be a valid http(s) URL
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
  } catch {
    return respond(400, { status: 'error', text: 'That doesn\'t look like a valid link.' });
  }

  // Call ZM API (POST form: { url })
  let data;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const res = await fetch('https://api.zm.io.vn/v1/social/autolink', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': API_KEY
      },
      body: JSON.stringify({ url }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return respond(502, {
        status: 'error',
        text: res.status === 401 || res.status === 403
          ? 'Downloader authorization failed. Please try again later.'
          : `Downloader returned an error (${res.status}). Try again in a moment.`
      });
    }

    data = await res.json();
  } catch (e) {
    return respond(504, {
      status: 'error',
      text: e.name === 'AbortError'
        ? 'The download timed out. Please try again.'
        : 'Could not reach the download service. Try again in a moment.'
    });
  }

  // Handle API-level errors — surface ZM's own message and the raw shape for debugging
  if (!data || data.error === true) {
    return respond(422, {
      status: 'error',
      text: (data && (data.message || data.msg || data.error_message))
        ? String(data.message || data.msg || data.error_message)
        : 'This link could not be processed. It may be private, removed, or unsupported.',
      debug: data || null
    });
  }

  const medias = Array.isArray(data.medias) ? data.medias : [];
  if (medias.length === 0) {
    return respond(422, {
      status: 'error',
      text: 'No downloadable media was found for this link.',
      debug: data
    });
  }

  // Split video vs audio
  const videos = medias
    .filter(m => (m.type || '').toLowerCase() === 'video' && m.url)
    .sort((a, b) => rank(a.quality) - rank(b.quality));
  const audios = medias
    .filter(m => (m.type || '').toLowerCase() === 'audio' && m.url);

  // Build a normalized "picker" the frontend renders
  const picker = [];

  if (isAudioOnly || quality === 'audio') {
    // Audio-first: put audio at the top, but still offer video below
    audios.forEach(a => picker.push({
      type: 'audio',
      label: 'Audio (MP3)',
      ext: a.extension || 'mp3',
      url: a.url
    }));
    videos.forEach(v => picker.push({
      type: 'video',
      label: labelFor(v.quality),
      ext: v.extension || 'mp4',
      url: v.url
    }));
  } else {
    videos.forEach(v => picker.push({
      type: 'video',
      label: labelFor(v.quality),
      ext: v.extension || 'mp4',
      url: v.url
    }));
    audios.forEach(a => picker.push({
      type: 'audio',
      label: 'Audio (MP3)',
      ext: a.extension || 'mp3',
      url: a.url
    }));
  }

  return respond(200, {
    status: 'picker',
    source: data.source || '',
    author: data.author || '',
    title: data.title || '',
    thumbnail: data.thumbnail || '',
    duration: data.duration || '',
    picker
  });
};
