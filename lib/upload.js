'use strict';

const net = require('node:net');
const dns = require('node:dns');
const { Agent, fetch: undiciFetch } = require('undici');
const { mapResponseToError, LenzError, LenzAPIError, LenzTimeoutError } = require('lenz-io');

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10,485,760 bytes (10 MiB)
const MAX_REDIRECTS = 5;

const MIME_TO_EXT = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const EXT_TO_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const isPrivateIpv4 = (ip) => {
  const parts = String(ip).split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    return false;
  }
  const [a, b, c] = parts.map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // 224.0.0.0/4 (multicast + reserved)
  return false;
};

const parseIpv6 = (host) => {
  const clean = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (!clean.includes(':')) return null;
  const lastColon = clean.lastIndexOf(':');
  const prefix = clean.slice(0, lastColon);
  const suffix = clean.slice(lastColon + 1);
  if (suffix.includes('.')) {
    const parts = suffix.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    return parseIpv6(`${prefix}:${hi}:${lo}`);
  }
  const [left, right] = clean.split('::');
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right !== undefined && right ? right.split(':') : [];
  let groups;
  if (right !== undefined) {
    const missing = 8 - (leftGroups.length + rightGroups.length);
    if (missing < 0) return null;
    const middle = Array(missing).fill('0');
    groups = [...leftGroups, ...middle, ...rightGroups];
  } else {
    groups = leftGroups;
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g || '0', 16));
};

const isPrivateOrReservedIp = (host) => {
  const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (net.isIPv4(clean)) {
    return isPrivateIpv4(clean);
  }
  if (net.isIPv6(clean) || clean.includes(':')) {
    const words = parseIpv6(clean);
    if (!words) return true; // unparseable IPv6 address -> block
    const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    // :: (unspecified) or ::1 (loopback)
    if (words.every((w) => w === 0)) return true;
    if (words.slice(0, 7).every((w) => w === 0) && w7 === 1) return true;
    // fe80::/10 link-local
    if ((w0 & 0xffc0) === 0xfe80) return true;
    // fec0::/10 site-local (deprecated, still routed internally on some networks)
    if ((w0 & 0xffc0) === 0xfec0) return true;
    // 2001:0::/32 Teredo: the client's IPv4 is embedded obfuscated, so the
    // whole prefix is refused rather than decoded.
    if (w0 === 0x2001 && w1 === 0x0000) return true;
    // 2002::/16 6to4: the IPv4 address is the next 32 bits.
    if (w0 === 0x2002) {
      const v4 = [(w1 >> 8) & 0xff, w1 & 0xff, (w2 >> 8) & 0xff, w2 & 0xff].join('.');
      if (isPrivateIpv4(v4)) return true;
    }
    // fc00::/7 unique-local
    if ((w0 & 0xfe00) === 0xfc00) return true;
    // ff00::/8 multicast
    if ((w0 & 0xff00) === 0xff00) return true;
    // 2001:db8::/32 documentation
    if (w0 === 0x2001 && w1 === 0x0db8) return true;

    // Check embedded IPv4:
    // 1. IPv4-mapped (::ffff:0:0/96)
    // 2. IPv4-compatible (::/96)
    // 3. NAT64 (64:ff9b::/96)
    const isMapped = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff;
    const isCompatible = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0;
    const isNat64 = w0 === 0x0064 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0;
    if (isMapped || isCompatible || isNat64) {
      const b1 = (w6 >> 8) & 0xff;
      const b2 = w6 & 0xff;
      const b3 = (w7 >> 8) & 0xff;
      const b4 = w7 & 0xff;
      const ipv4Str = [b1, b2, b3, b4].join('.');
      if (isPrivateIpv4(ipv4Str)) return true;
    }
  }
  return false;
};

const validateFileUrl = (rawUrl, z, isSample = false) => {
  const throwInvalid = (msg) => {
    throw isSample
      ? new z.errors.Error(msg, 'InvalidInput', 422)
      : new z.errors.HaltedError(msg);
  };

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throwInvalid('Invalid file URL.');
  }

  if (parsed.protocol !== 'https:') {
    throwInvalid('Only HTTPS file URLs are supported.');
  }

  if (parsed.username || parsed.password) {
    throwInvalid('File URLs must not contain authentication credentials.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.metadata.google.internal') ||
    host === 'instance-data' ||
    host.endsWith('.instance-data') ||
    isPrivateOrReservedIp(host)
  ) {
    throwInvalid('File URL must not point to a local, private, or metadata address.');
  }

  return parsed;
};

const verifyDns = async (host, z, isSample, lookupImpl) => {
  const lookup = lookupImpl || dns.promises.lookup;
  try {
    const addresses = await lookup(host, { all: true });
    for (const addr of addresses) {
      if (isPrivateOrReservedIp(addr.address)) {
        const msg = 'File URL resolves to a local, private, or metadata address.';
        throw isSample
          ? new z.errors.Error(msg, 'InvalidInput', 422)
          : new z.errors.HaltedError(msg);
      }
    }
  } catch (err) {
    if (err instanceof z.errors.Error || err instanceof z.errors.HaltedError) {
      throw err;
    }
    const msg = `Could not resolve file host "${host}": ${err.message}`;
    throw isSample
      ? new z.errors.Error(msg, 'FileDownloadFailed', 422)
      : new z.errors.HaltedError(msg);
  }
};

// The address check that actually binds. verifyDns above vets the host, but
// `fetch` then resolves it again on its own, so a domain answering a public
// address first and an internal one second (DNS rebinding) would pass. This
// lookup runs AT CONNECT TIME, for every connection the download makes
// (redirect hops included), and refuses before a socket opens: the address
// checked is the address used.
const BLOCKED_ADDRESS = 'LENZ_BLOCKED_ADDRESS';

const guardedLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => isPrivateOrReservedIp(a.address));
    if (blocked || addresses.length === 0) {
      const refused = new Error('File URL resolves to a local, private, or metadata address.');
      refused.code = BLOCKED_ADDRESS;
      return callback(refused);
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
};

const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });

// The download's default fetch: undici's own, so its dispatcher option is the
// same undici version the Agent above comes from.
const guardedFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: guardedAgent });

// True when a fetch failed because guardedLookup refused the address. undici
// nests the cause (TypeError: fetch failed -> cause), sometimes twice.
const isBlockedAddress = (err) => {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.code === BLOCKED_ADDRESS) return true;
  }
  return false;
};

const normalizeFilenameAndMime = (rawFilename, rawContentType) => {
  let filename = String(rawFilename || '')
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/[\x00-\x1f\x7f"]/g, '')
    .trim();

  const rawType = String(rawContentType || '')
    .split(';')[0]
    .replace(/[\r\n]/g, '')
    .trim()
    .toLowerCase();

  let contentType = /^[a-z0-9!#$&^_+.-]+\/[a-z0-9!#$&^_+.-]+$/i.test(rawType)
    ? rawType
    : 'application/octet-stream';

  if (!filename) {
    if (MIME_TO_EXT[contentType]) {
      filename = 'upload' + MIME_TO_EXT[contentType];
    } else {
      // Keep the fallback filename extensionless when the MIME type is unknown.
      filename = 'upload';
    }
  }

  const extMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';

  // When MIME is one of our supported MIME types and the extension is NOT one of our known extensions,
  // append the known extension (e.g. download.php + docx MIME -> download.php.docx)
  if (MIME_TO_EXT[contentType] && !EXT_TO_MIME[ext]) {
    filename = filename + MIME_TO_EXT[contentType];
  }

  // A server that does not say what the file is (a generic type such as S3's
  // default `binary/octet-stream`, `application/x-download`, or `text/plain`)
  // is overruled by a known extension: Lenz decides by the type it is sent,
  // and would refuse a real `.pdf` sent as `binary/octet-stream`. A supported
  // type the server did state always wins.
  if (!MIME_TO_EXT[contentType]) {
    const updatedExtMatch = filename.match(/\.([a-zA-Z0-9]+)$/);
    const updatedExt = updatedExtMatch ? '.' + updatedExtMatch[1].toLowerCase() : '';
    if (EXT_TO_MIME[updatedExt]) {
      contentType = EXT_TO_MIME[updatedExt];
    } else if (!contentType) {
      contentType = 'application/octet-stream';
    }
  }

  return { filename, contentType };
};

const downloadFileUrl = async (
  z,
  rawUrl,
  {
    timeoutMs = 28000,
    isSample = false,
    fetchImpl = guardedFetch,
    dnsLookup = false,
    lookupImpl,
  } = {},
) => {
  const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;
  let currentUrl = rawUrl;
  let redirects = 0;
  let res;

  while (true) {
    const parsed = validateFileUrl(currentUrl, z, isSample);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
    // An early, clearer refusal for the common case. The binding check is
    // guardedLookup, at connect time, on the default fetch.
    if ((fetchImpl === guardedFetch || dnsLookup) && net.isIP(host) === 0) {
      await verifyDns(host, z, isSample, lookupImpl);
    }

    const remainingMs = deadline ? Math.max(1000, deadline - Date.now()) : timeoutMs;
    try {
      res = await fetchImpl(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: remainingMs ? AbortSignal.timeout(remainingMs) : undefined,
      });
    } catch (err) {
      // A refused address is a fact about the URL, not a passing failure:
      // halt, never "Zapier will retry".
      if (isBlockedAddress(err)) {
        const msg = 'File URL resolves to a local, private, or metadata address.';
        throw isSample ? new z.errors.Error(msg, 'InvalidInput', 422) : new z.errors.HaltedError(msg);
      }
      if (isSample) {
        throw new z.errors.Error(`Could not download the file URL: ${err.message}`, 'FileDownloadError', 502);
      }
      throw new z.errors.ThrottledError(
        'Could not download the file URL (temporary failure); Zapier will retry.',
        60,
      );
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      redirects++;
      if (redirects > MAX_REDIRECTS) {
        const msg = `Too many redirects (exceeded ${MAX_REDIRECTS}).`;
        throw isSample
          ? new z.errors.Error(msg, 'FileDownloadFailed', 422)
          : new z.errors.HaltedError(msg);
      }
      const location = res.headers.get('location');
      if (!location) {
        const msg = `Redirect HTTP ${res.status} missing Location header.`;
        throw isSample
          ? new z.errors.Error(msg, 'FileDownloadFailed', res.status)
          : new z.errors.HaltedError(msg);
      }
      // Release the hop's connection before following it: an unread body
      // holds its socket until garbage collection.
      if (res.body && typeof res.body.cancel === 'function') {
        await res.body.cancel().catch(() => {});
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    break;
  }

  if (!res.ok) {
    const isTransient = res.status === 408 || res.status === 429 || res.status >= 500;
    if (isTransient) {
      if (isSample) {
        throw new z.errors.Error(`Could not download the file URL (HTTP ${res.status}).`, 'FileDownloadError', res.status);
      }
      throw new z.errors.ThrottledError(
        `Could not download the file URL (HTTP ${res.status} temporary failure); Zapier will retry.`,
        60,
      );
    }
    const msg = `Could not download the file URL (HTTP ${res.status}). Check that the file link is still valid and accessible.`;
    throw isSample
      ? new z.errors.Error(msg, 'FileDownloadFailed', res.status)
      : new z.errors.HaltedError(msg);
  }

  const contentLengthHeader = res.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const len = Number(contentLengthHeader);
    if (Number.isFinite(len) && len > MAX_FILE_BYTES) {
      if (res.body && typeof res.body.cancel === 'function') {
        res.body.cancel().catch(() => {});
      }
      const msg = `File is ${len} bytes, which exceeds Lenz's 10 MB (10,485,760 bytes) limit.`;
      throw isSample
        ? new z.errors.Error(msg, 'FileTooLarge', 422)
        : new z.errors.HaltedError(msg);
    }
  }

  let buffer;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalBytes += value.length;
            if (totalBytes > MAX_FILE_BYTES) {
              await reader.cancel().catch(() => {});
              const msg = `File is ${totalBytes} bytes, which exceeds Lenz's 10 MB (10,485,760 bytes) limit.`;
              throw isSample
                ? new z.errors.Error(msg, 'FileTooLarge', 422)
                : new z.errors.HaltedError(msg);
            }
            chunks.push(value);
          }
        }
      } finally {
        if (typeof reader.releaseLock === 'function') {
          try {
            reader.releaseLock();
          } catch {}
        }
      }
      buffer = Buffer.concat(chunks);
    } else {
      const arrayBuf = await res.arrayBuffer();
      if (arrayBuf.byteLength > MAX_FILE_BYTES) {
        const msg = `File is ${arrayBuf.byteLength} bytes, which exceeds Lenz's 10 MB (10,485,760 bytes) limit.`;
        throw isSample
          ? new z.errors.Error(msg, 'FileTooLarge', 422)
          : new z.errors.HaltedError(msg);
      }
      buffer = Buffer.from(arrayBuf);
    }
  } catch (err) {
    if (err instanceof z.errors.Error || err instanceof z.errors.HaltedError) {
      throw err;
    }
    if (isSample) {
      throw new z.errors.Error(`Could not download the file URL: ${err.message}`, 'FileDownloadError', 502);
    }
    throw new z.errors.ThrottledError(
      'Could not download the file URL (temporary failure); Zapier will retry.',
      60,
    );
  }

  if (buffer.length === 0) {
    const msg = 'The uploaded file is empty (0 bytes).';
    throw isSample
      ? new z.errors.Error(msg, 'EmptyFile', 422)
      : new z.errors.HaltedError(msg);
  }

  let rawFilename = '';
  const cd = res.headers.get('content-disposition');
  if (cd) {
    const starMatch = cd.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i);
    if (starMatch) {
      try {
        rawFilename = decodeURIComponent(starMatch[1].trim());
      } catch {}
    }
    if (!rawFilename) {
      const match = cd.match(/filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s\r\n]+))/i);
      if (match) {
        rawFilename = match[1] || match[2] || match[3] || '';
      }
    }
  }
  if (!rawFilename) {
    try {
      const parsedUrl = new URL(currentUrl);
      const basename = parsedUrl.pathname.replace(/^.*[\\/]/, '');
      if (basename && basename !== '/') {
        try {
          rawFilename = decodeURIComponent(basename);
        } catch {
          rawFilename = basename;
        }
      }
    } catch {}
  }

  const rawContentType = res.headers.get('content-type');
  const { filename, contentType } = normalizeFilenameAndMime(rawFilename, rawContentType);

  return { buffer, filename, contentType };
};

const BASE_URL = process.env.LENZ_BASE_URL || 'https://lenz.io/api/v1';

// One transport for both multipart endpoints: auth and Idempotency-Key
// headers, the abort budget, and the SDK's own error classes, so
// lib/errors.js maps a file call exactly like any other. `timeoutMs` is the
// only budget option: an alias (`timeout`) once let a caller's remaining
// budget lose to the wrapper's default.
//
// `onErrorResponse(status, text)` may return a value to treat an
// error status as an answer (the /review/file 409 receipt below).
const postMultipart = async (path, form, options = {}, onErrorResponse) => {
  const { apiKey, baseUrl = BASE_URL, idempotencyKey, timeoutMs, fetchImpl = fetch } = options;
  const headers = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };

  let response;
  let text;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      body: form,
      headers,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    text = await response.text();
  } catch (err) {
    if (err instanceof LenzError) {
      throw err;
    }
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new LenzTimeoutError({ message: err.message || 'Request timed out' });
    }
    throw new LenzAPIError({
      message: err && err.message ? err.message : 'Network error',
      statusCode: 0,
      body: '',
    });
  }

  const resHeaders = Object.fromEntries(response.headers.entries());

  if (!response.ok) {
    const answer = onErrorResponse && onErrorResponse(response.status, text);
    if (answer) return answer;
    throw mapResponseToError(response.status, text, resHeaders);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new LenzAPIError({
      message: 'Invalid JSON response from Lenz',
      statusCode: response.status,
      body: text,
    });
  }

  return parsed;
};

const extractFileWithZapier = async (
  { file, filename, contentType, language, focus, locate, idempotencyKey },
  options = {},
) => {
  const form = new FormData();
  form.append('file', new Blob([file], { type: contentType }), filename);
  if (language) form.append('language', language);
  if (focus) form.append('focus', focus);
  if (typeof locate === 'boolean') form.append('locate', String(locate));

  return postMultipart('/extract/file', form, { idempotencyKey, ...options });
};

const reviewFileWithZapier = async (
  {
    file,
    filename,
    contentType,
    language,
    visibility,
    webhookUrl,
    suppliedSources,
    maxAssessments,
    maxVerifications,
    maxCitations,
    depth,
    verdicts,
    confidence,
    suggestEdits,
    idempotencyKey,
  },
  options = {},
) => {
  const form = new FormData();
  form.append('file', new Blob([file], { type: contentType }), filename);
  if (language) form.append('language', language);
  // Private unless asked otherwise, as the SDK sends on the text path and as
  // the Visibility help text promises ("Leave blank for Private").
  form.append('visibility', visibility || 'private');
  if (webhookUrl) form.append('webhook_url', webhookUrl);

  const escalate = {};
  if (maxAssessments !== undefined && maxAssessments !== null && maxAssessments !== '') {
    escalate.max_assessments = Number(maxAssessments);
  }
  if (maxVerifications !== undefined && maxVerifications !== null && maxVerifications !== '') {
    escalate.max_verifications = Number(maxVerifications);
  }
  if (maxCitations !== undefined && maxCitations !== null && maxCitations !== '') {
    escalate.max_citations = Number(maxCitations);
  }
  if (depth !== undefined && depth !== null && depth !== '') {
    escalate.depth = depth;
  }
  if (verdicts !== undefined && verdicts !== null && verdicts !== '') {
    escalate.verdicts = verdicts;
  }
  if (confidence !== undefined && confidence !== null && confidence !== '') {
    escalate.confidence = confidence;
  }
  if (suggestEdits !== undefined && suggestEdits !== null) {
    escalate.suggest_edits = Boolean(suggestEdits);
  }
  if (Object.keys(escalate).length > 0) {
    form.append('escalate', JSON.stringify(escalate));
  }
  if (Array.isArray(suppliedSources) && suppliedSources.length > 0) {
    form.append('supplied_sources', JSON.stringify(suppliedSources));
  }

  // A replay that arrives while the first upload's review is being created
  // gets 409 `idempotency_conflict` naming the review: that IS the receipt,
  // as the SDK treats it on /review.
  const receiptFrom409 = (status, text) => {
    if (status !== 409) return null;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (body && body.code === 'idempotency_conflict' && typeof body.review_id === 'string' && body.review_id) {
      return { review_id: body.review_id, status: body.status || 'queued', kept: Boolean(body.kept) };
    }
    return null;
  };

  return postMultipart('/review/file', form, { idempotencyKey, ...options }, receiptFrom409);
};

module.exports = {
  MAX_FILE_BYTES,
  MAX_REDIRECTS,
  MIME_TO_EXT,
  EXT_TO_MIME,
  isPrivateIpv4,
  isPrivateOrReservedIp,
  validateFileUrl,
  normalizeFilenameAndMime,
  guardedLookup,
  isBlockedAddress,
  downloadFileUrl,
  extractFileWithZapier,
  reviewFileWithZapier,
};
