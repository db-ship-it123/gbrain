/**
 * eval/runner/loaders/pdf.ts tests.
 *
 * Does NOT test real PDF parsing (that's Cat 11 integration territory with
 * actual fixture PDFs via `bun run eval:fetch-multimodal`). Focuses on the
 * guard behavior + error class shape that Cat 11 depends on.
 */

import { describe, test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractPdfText,
  PdfEncryptedError,
  PdfParseError,
  PdfTooLargeError,
} from '../../eval/runner/loaders/pdf.ts';

function tmpFile(content: Uint8Array | string, name: string): string {
  const dir = join(tmpdir(), `pdf-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content as any);
  return path;
}

describe('extractPdfText — guards', () => {
  test('throws PdfParseError for non-existent file', async () => {
    let err: unknown = null;
    try {
      await extractPdfText('/nonexistent/path/to/file.pdf');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfParseError);
  });

  test('throws PdfTooLargeError when file exceeds maxBytes', async () => {
    const big = new Uint8Array(2048);
    const path = tmpFile(big, 'big.pdf');
    let err: unknown = null;
    try {
      await extractPdfText(path, { maxBytes: 1024 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfTooLargeError);
    rmSync(path);
  });

  test('throws PdfParseError for non-PDF content', async () => {
    const junk = 'this is not a PDF file';
    const path = tmpFile(junk, 'not-a-pdf.pdf');
    let err: unknown = null;
    try {
      await extractPdfText(path);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PdfParseError);
    rmSync(path);
  });
});

describe('error classes', () => {
  test('PdfEncryptedError has kind = "encrypted"', () => {
    const err = new PdfEncryptedError('/x.pdf');
    expect(err.kind).toBe('encrypted');
    expect(err.name).toBe('PdfEncryptedError');
    expect(err.message).toContain('/x.pdf');
  });

  test('PdfTooLargeError reports size + max', () => {
    const err = new PdfTooLargeError('/x.pdf', 5_000_000, 1_000_000);
    expect(err.kind).toBe('too_large');
    expect(err.message).toContain('5000000');
    expect(err.message).toContain('1000000');
  });

  test('PdfParseError preserves cause chain', () => {
    const inner = new Error('underlying failure');
    const err = new PdfParseError('/x.pdf', inner);
    expect(err.kind).toBe('parse');
    expect((err as Error & { cause?: unknown }).cause).toBe(inner);
  });
});
