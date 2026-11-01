/* globals describe, it, expect, jest, beforeEach, afterEach */

'use strict';

const zapier = require('zapier-platform-core');
const App = require('../index');
const {
  validateFileUrl,
  normalizeFilenameAndMime,
  downloadFileUrl,
  extractFileWithZapier,
  reviewFileWithZapier,
  isPrivateIpv4,
  isPrivateOrReservedIp,
  MAX_FILE_BYTES,
} = require('../lib/upload');
const { FILE_REFUSAL_CODES } = require('../lib/errors');
const { lenzClient } = require('../client');

const zStub = {
  errors: {
    HaltedError: zapier.errors.HaltedError,
    Error: zapier.errors.Error,
    ThrottledError: zapier.errors.ThrottledError,
    ExpiredAuthError: zapier.errors.ExpiredAuthError,
  },
  console: { log: jest.fn(), error: jest.fn() },
  hash: (algo, buf, enc) => require('crypto').createHash(algo).update(buf).digest(enc),
};

describe('lib/upload.js', () => {
  describe('validateFileUrl', () => {
    it('accepts valid public https URLs', () => {
      const url = validateFileUrl('https://example.com/doc.pdf', zStub, false);
      expect(url.href).toBe('https://example.com/doc.pdf');
    });

    it('rejects non-https URLs', () => {
      expect(() => validateFileUrl('http://example.com/doc.pdf', zStub, false)).toThrow(zStub.errors.HaltedError);
      expect(() => validateFileUrl('ftp://example.com/doc.pdf', zStub, true)).toThrow(zStub.errors.Error);
    });

    it('rejects URLs with credentials', () => {
      expect(() => validateFileUrl('https://user:pass@example.com/doc.pdf', zStub, false)).toThrow(
        zStub.errors.HaltedError,
      );
    });

    it('rejects localhost, private IPs, and cloud metadata', () => {
      const blocked = [
        'https://localhost/file.pdf',
        'https://localhost./file.pdf',
        'https://127.0.0.1/file.pdf',
        'https://10.0.0.1/file.pdf',
        'https://172.16.0.1/file.pdf',
        'https://192.168.1.1/file.pdf',
        'https://169.254.169.254/file.pdf',
        'https://100.100.100.200/file.pdf',
        'https://metadata.google.internal/file.pdf',
        'https://[::1]/file.pdf',
        'https://[fe80::1]/file.pdf',
        'https://[::ffff:127.0.0.1]/file.pdf',
        'https://[::ffff:7f00:1]/file.pdf',
        'https://[::ffff:169.254.169.254]/file.pdf',
        'https://[64:ff9b::7f00:1]/file.pdf',
      ];
      for (const u of blocked) {
        expect(() => validateFileUrl(u, zStub, false)).toThrow(zStub.errors.HaltedError);
        expect(() => validateFileUrl(u, zStub, true)).toThrow(zStub.errors.Error);
      }
    });

    it('rejects unparseable URLs', () => {
      expect(() => validateFileUrl('not-a-url', zStub, false)).toThrow(zStub.errors.HaltedError);
      expect(() => validateFileUrl('', zStub, true)).toThrow(zStub.errors.Error);
    });
  });

  describe('normalizeFilenameAndMime', () => {
    it('handles clean known filename and matching mime', () => {
      const res = normalizeFilenameAndMime('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(res.filename).toBe('report.docx');
      expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('strips paths and control characters', () => {
      const res = normalizeFilenameAndMime('../../secret/report\r\n.pdf', 'application/pdf');
      expect(res.filename).toBe('report.pdf');
    });

    it('uses upload + ext if name becomes empty after sanitizing', () => {
      const res = normalizeFilenameAndMime('///', 'image/png');
      expect(res.filename).toBe('upload.png');
      expect(res.contentType).toBe('image/png');
    });

    it('leaves upload extensionless when mime is unknown (never upload.bin)', () => {
      const res = normalizeFilenameAndMime('', 'application/octet-stream');
      expect(res.filename).toBe('upload');
      expect(res.contentType).toBe('application/octet-stream');
    });

    it('maps known extension to canonical mime if content-type missing', () => {
      const res = normalizeFilenameAndMime('scan.webp', '');
      expect(res.filename).toBe('scan.webp');
      expect(res.contentType).toBe('image/webp');
    });

    it('appends matching extension when filename extension does not match known MIME (e.g. download.php -> download.php.docx)', () => {
      const res = normalizeFilenameAndMime(
        'download.php',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(res.filename).toBe('download.php.docx');
      expect(res.contentType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    });

    it('handles rawFilename and rawContentType that are not strings', () => {
      const res = normalizeFilenameAndMime(null, undefined);
      expect(res.filename).toBe('upload');
      expect(res.contentType).toBe('application/octet-stream');
    });
  });

  describe('downloadFileUrl', () => {
    it('downloads successfully within limit', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="test.pdf"',
        }),
        arrayBuffer: async () => Buffer.from('%PDF-1.4 test content'),
      });

      const res = await downloadFileUrl(zStub, 'https://example.com/test.pdf', {
        fetchImpl: mockFetch,
      });

      expect(res.filename).toBe('test.pdf');
      expect(res.contentType).toBe('application/pdf');
      expect(res.buffer.toString()).toBe('%PDF-1.4 test content');
    });

    it('follows safe https redirect', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: 'https://example.com/final.pdf' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'application/pdf' }),
          arrayBuffer: async () => Buffer.from('%PDF-1.4 final doc'),
        });

      const res = await downloadFileUrl(zStub, 'https://example.com/initial.pdf', {
        fetchImpl: mockFetch,
      });
      expect(res.filename).toBe('final.pdf');
      expect(res.buffer.toString()).toBe('%PDF-1.4 final doc');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('rejects redirect to private IP or http', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'https://127.0.0.1/secret.pdf' }),
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial.pdf', { fetchImpl: mockFetch }),
      ).rejects.toThrow(zStub.errors.HaltedError);

      const mockFetchHttp = jest.fn().mockResolvedValue({
        status: 301,
        headers: new Headers({ location: 'http://example.com/insecure.pdf' }),
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial.pdf', { fetchImpl: mockFetchHttp }),
      ).rejects.toThrow(zStub.errors.HaltedError);
    });

    it('rejects empty file', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        arrayBuffer: async () => Buffer.alloc(0),
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/empty.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow(zStub.errors.HaltedError);

      await expect(
        downloadFileUrl(zStub, 'https://example.com/empty.pdf', { fetchImpl: mockFetch, isSample: true }),
      ).rejects.toThrow(zStub.errors.Error);
    });

    it('rejects file when Content-Length exceeds limit', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'application/pdf',
          'Content-Length': String(MAX_FILE_BYTES + 1),
        }),
        arrayBuffer: async () => Buffer.alloc(10),
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/large.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow(zStub.errors.HaltedError);
    });

    it('rejects file when body size exceeds limit', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        arrayBuffer: async () => Buffer.alloc(MAX_FILE_BYTES + 5),
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/large.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow(zStub.errors.HaltedError);
    });

    it('maps 401/403/404 from file-host to HaltedError in live mode and Error in sample mode', async () => {
      for (const status of [401, 403, 404]) {
        const mockFetch = jest.fn().mockResolvedValue({
          ok: false,
          status,
          statusText: 'Host error',
          headers: new Headers(),
          text: async () => 'error body',
        });

        await expect(
          downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: false }),
        ).rejects.toThrow(zStub.errors.HaltedError);

        await expect(
          downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: true }),
        ).rejects.toThrow(zStub.errors.Error);
      }
    });

    it('maps transient errors (408, 429, 500, 502, 503) to ThrottledError in live mode and Error in sample mode', async () => {
      for (const status of [408, 429, 500, 502, 503]) {
        const mockFetch = jest.fn().mockResolvedValue({
          ok: false,
          status,
          statusText: 'Temporary error',
          headers: new Headers(),
          text: async () => 'temp error body',
        });

        await expect(
          downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: false }),
        ).rejects.toThrow(zStub.errors.ThrottledError);

        await expect(
          downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: true }),
        ).rejects.toThrow(zStub.errors.Error);
      }
    });

    it('maps network/timeout errors to ThrottledError in live mode and Error in sample mode', async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      await expect(
        downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow(zStub.errors.ThrottledError);

      await expect(
        downloadFileUrl(zStub, 'https://example.com/file.pdf', { fetchImpl: mockFetch, isSample: true }),
      ).rejects.toThrow(zStub.errors.Error);
    });
  });

  describe('extractFileWithZapier and reviewFileWithZapier', () => {
    it('extractFileWithZapier sends multipart POST and handles 200', async () => {
      let sentFormData = null;
      let sentHeaders = null;
      const mockFetch = jest.fn().mockImplementation(async (url, init) => {
        sentFormData = init.body;
        sentHeaders = init.headers;
        return new Response(
          JSON.stringify({
            status: 'ok',
            claims: [{ claim: 'Extracted claim', line: 1 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      });

      const res = await extractFileWithZapier(
        {
          file: Buffer.from('test docx'),
          filename: 'draft.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          language: 'en',
          focus: 'financials',
          idempotencyKey: 'idem-123',
        },
        {
          baseUrl: 'https://api.lenz.io',
          apiKey: 'lenz_test',
          fetchImpl: mockFetch,
        },
      );

      expect(res.status).toBe('ok');
      expect(sentHeaders.Authorization).toBe('Bearer lenz_test');
      expect(sentHeaders['Idempotency-Key']).toBe('idem-123');
      expect(sentFormData.get('language')).toBe('en');
      expect(sentFormData.get('focus')).toBe('financials');
      const fileBlob = sentFormData.get('file');
      expect(fileBlob).toBeTruthy();
      expect(fileBlob.name).toBe('draft.docx');
    });

    it('reviewFileWithZapier sends multipart POST and handles 202', async () => {
      let sentFormData = null;
      const mockFetch = jest.fn().mockImplementation(async (url, init) => {
        sentFormData = init.body;
        return new Response(
          JSON.stringify({
            review_id: 'rev_999',
            status: 'queued',
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      });

      const res = await reviewFileWithZapier(
        {
          file: Buffer.from('%PDF-1.4 pdf'),
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          webhookUrl: 'https://zapier.com/hook',
          idempotencyKey: 'idem-rev',
          depth: 'standard',
          maxVerifications: 5,
          maxCitations: 10,
          visibility: 'unlisted',
          suppliedSources: [{ text: 'source 1' }],
        },
        {
          baseUrl: 'https://api.lenz.io',
          apiKey: 'lenz_test',
          fetchImpl: mockFetch,
        },
      );

      expect(res.review_id).toBe('rev_999');
      expect(res.status).toBe('queued');
      expect(sentFormData.get('webhook_url')).toBe('https://zapier.com/hook');
      const parsedEscalate = JSON.parse(sentFormData.get('escalate'));
      expect(parsedEscalate.depth).toBe('standard');
      expect(parsedEscalate.max_verifications).toBe(5);
      expect(parsedEscalate.max_citations).toBe(10);
      expect(sentFormData.get('visibility')).toBe('unlisted');
      expect(sentFormData.get('supplied_sources')).toBe(JSON.stringify([{ text: 'source 1' }]));
    });

    it('reviewFileWithZapier recovers on 409 idempotency_conflict when review_id is present', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 409,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            code: 'idempotency_conflict',
            review_id: 'rev_replayed',
            status: 'queued',
          }),
      });

      const res = await reviewFileWithZapier(
        {
          file: Buffer.from('%PDF-1.4 pdf'),
          webhookUrl: 'https://zapier.com/hook',
        },
        {
          baseUrl: 'https://api.lenz.io',
          token: 'lenz_test',
          fetchImpl: mockFetch,
        },
      );

      expect(res.review_id).toBe('rev_replayed');
      expect(res.status).toBe('queued');
    });

    it('reviewFileWithZapier throws on other non-ok errors', async () => {
      const mockFetch = jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            detail: 'Server exploded',
            code: 'internal_error',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await expect(
        reviewFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'lenz_test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow();
    });

    it('maps encrypted_file 422 through extractFile and mapLenzError to HaltedError with file is encrypted', async () => {
      const { mapLenzError } = require('../lib/errors');
      const mockFetch = jest.fn().mockResolvedValue({
        status: 422,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            detail: 'File is encrypted and cannot be processed.',
            code: 'encrypted_file',
          }),
      });

      let caught = null;
      try {
        await extractFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeTruthy();
      expect(() => mapLenzError(zStub, caught, { isSample: false })).toThrow(zStub.errors.HaltedError);
      expect(() => mapLenzError(zStub, caught, { isSample: false })).toThrow('File is encrypted');
    });

    it('maps network/timeout TypeError in extractFile through mapLenzError to ThrottledError', async () => {
      const { mapLenzError } = require('../lib/errors');
      const mockFetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));

      let caught = null;
      try {
        await extractFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeTruthy();
      expect(() => mapLenzError(zStub, caught, { isSample: false })).toThrow(zStub.errors.ThrottledError);
    });

    it('maps invalid non-JSON 200 response to LenzAPIError', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/html' }),
        text: async () => '<html>bad gateway</html>',
      });

      await expect(
        extractFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('Invalid JSON response from Lenz');
    });
  });

  describe('FILE_REFUSAL_CODES mapping in lib/errors.js', () => {
    it('maps refusal codes to HaltedError in live runs and Error in sample runs', async () => {
      const { mapLenzError } = require('../lib/errors');
      const { LenzValidationError } = require('lenz-io');

      for (const code of FILE_REFUSAL_CODES) {
        const err = new LenzValidationError({
          message: `File rejected: ${code}`,
          statusCode: 422,
          code,
        });

        expect(() => mapLenzError(zStub, err, { isSample: false })).toThrow(zStub.errors.HaltedError);
        expect(() => mapLenzError(zStub, err, { isSample: true })).toThrow(zStub.errors.Error);
      }
    });
  });

  describe('upload edge cases and coverage branches', () => {
    it('isPrivateIpv4 returns false for non-ipv4 strings', () => {
      expect(isPrivateIpv4('not.an.ip')).toBe(false);
      expect(isPrivateIpv4('1.2.3')).toBe(false);
      expect(isPrivateIpv4('1.2.3.256')).toBe(false);
    });

    it('isPrivateOrReservedIp handles ipv6 without double colons and ipv4 suffixes', () => {
      expect(isPrivateOrReservedIp('2001:db8:0:0:0:0:0:1')).toBe(true); // doc range
      expect(isPrivateOrReservedIp('2607:f8b0:4005:805::200e')).toBe(false); // public google ipv6
      expect(isPrivateOrReservedIp('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
    });

    it('verifyDns halts when DNS resolves to private IP', async () => {
      const mockLookup = jest.fn().mockResolvedValue([{ address: '127.0.0.1' }]);
      await expect(
        downloadFileUrl(zStub, 'https://my-host.com/file.pdf', {
          dnsLookup: true,
          lookupImpl: mockLookup,
          isSample: false,
        }),
      ).rejects.toThrow(zStub.errors.HaltedError);

      await expect(
        downloadFileUrl(zStub, 'https://my-host.com/file.pdf', {
          dnsLookup: true,
          lookupImpl: mockLookup,
          isSample: true,
        }),
      ).rejects.toThrow(zStub.errors.Error);
    });

    it('verifyDns halts when DNS resolution fails', async () => {
      const mockLookup = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
      await expect(
        downloadFileUrl(zStub, 'https://unresolvable.test/file.pdf', {
          dnsLookup: true,
          lookupImpl: mockLookup,
          isSample: false,
        }),
      ).rejects.toThrow(zStub.errors.HaltedError);

      await expect(
        downloadFileUrl(zStub, 'https://unresolvable.test/file.pdf', {
          dnsLookup: true,
          lookupImpl: mockLookup,
          isSample: true,
        }),
      ).rejects.toThrow(zStub.errors.Error);
    });

    it('downloadFileUrl halts when redirects exceed MAX_REDIRECTS', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'https://example.com/loop' }),
      });
      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow('Too many redirects');

      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial', { fetchImpl: mockFetch, isSample: true }),
      ).rejects.toThrow('Too many redirects');
    });

    it('downloadFileUrl halts when redirect is missing Location header', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 301,
        headers: new Headers(),
      });
      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow('missing Location header');

      await expect(
        downloadFileUrl(zStub, 'https://example.com/initial', { fetchImpl: mockFetch, isSample: true }),
      ).rejects.toThrow('missing Location header');
    });

    it('downloadFileUrl cancels body when Content-Length exceeds MAX_FILE_BYTES', async () => {
      const mockCancel = jest.fn().mockResolvedValue();
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Length': String(MAX_FILE_BYTES + 100) }),
        body: { cancel: mockCancel },
      });
      await expect(
        downloadFileUrl(zStub, 'https://example.com/too-big.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow('exceeds Lenz');
      expect(mockCancel).toHaveBeenCalled();
    });

    it('downloadFileUrl streams body chunks and halts if totalBytes exceeds limit', async () => {
      let readCount = 0;
      const mockCancel = jest.fn().mockResolvedValue();
      const mockReleaseLock = jest.fn();
      const mockReader = {
        read: jest.fn().mockImplementation(async () => {
          readCount++;
          if (readCount === 1) return { done: false, value: Buffer.alloc(MAX_FILE_BYTES + 10) };
          return { done: true };
        }),
        cancel: mockCancel,
        releaseLock: mockReleaseLock,
      };
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        body: { getReader: () => mockReader },
      });

      await expect(
        downloadFileUrl(zStub, 'https://example.com/stream-big.pdf', { fetchImpl: mockFetch, isSample: false }),
      ).rejects.toThrow('exceeds Lenz');
      expect(mockCancel).toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalled();
    });

    it('downloadFileUrl streams body chunks successfully within limit', async () => {
      let readCount = 0;
      const mockReader = {
        read: jest.fn().mockImplementation(async () => {
          readCount++;
          if (readCount === 1) return { done: false, value: Buffer.from('%PDF-1.4 stream') };
          return { done: true };
        }),
        releaseLock: jest.fn(),
      };
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        body: { getReader: () => mockReader },
      });

      const res = await downloadFileUrl(zStub, 'https://example.com/stream.pdf', { fetchImpl: mockFetch });
      expect(res.buffer.toString()).toBe('%PDF-1.4 stream');
    });

    it('downloadFileUrl parses filename* in Content-Disposition', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'application/pdf',
          'Content-Disposition': "attachment; filename*=UTF-8''my%20report.pdf",
        }),
        arrayBuffer: async () => Buffer.from('data'),
      });
      const res = await downloadFileUrl(zStub, 'https://example.com/file', { fetchImpl: mockFetch });
      expect(res.filename).toBe('my report.pdf');
    });

    it('extractFileWithZapier rethrows LenzError directly', async () => {
      const { LenzError } = require('lenz-io');
      const err = new LenzError({ message: 'Custom Lenz error' });
      const mockFetch = jest.fn().mockRejectedValue(err);

      await expect(
        extractFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('Custom Lenz error');
    });

    it('extractFileWithZapier maps AbortError to LenzTimeoutError', async () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      const mockFetch = jest.fn().mockRejectedValue(abortErr);

      await expect(
        extractFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('The operation was aborted');
    });

    it('reviewFileWithZapier rethrows LenzError directly and maps AbortError', async () => {
      const { LenzError } = require('lenz-io');
      const err = new LenzError({ message: 'Custom Lenz error review' });
      const mockFetch = jest.fn().mockRejectedValue(err);

      await expect(
        reviewFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('Custom Lenz error review');

      const abortErr = new Error('Timeout on review');
      abortErr.name = 'TimeoutError';
      mockFetch.mockRejectedValue(abortErr);

      await expect(
        reviewFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('Timeout on review');
    });

    it('reviewFileWithZapier throws on 409 idempotency conflict when review_id is missing', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        status: 409,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        text: async () => JSON.stringify({ code: 'idempotency_conflict' }),
      });

      await expect(
        reviewFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow();
    });

    it('reviewFileWithZapier throws on invalid JSON on 200 response', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/html' }),
        text: async () => '<html>bad</html>',
      });

      await expect(
        reviewFileWithZapier(
          { file: Buffer.from('data') },
          { baseUrl: 'https://api.lenz.io', apiKey: 'test', fetchImpl: mockFetch },
        ),
      ).rejects.toThrow('Invalid JSON response from Lenz');
    });
  });
});
