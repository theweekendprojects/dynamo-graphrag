import { describe, it, expect } from 'vitest';
import { slugify } from './slugify.js';

describe('slugify', () => {
  it('lowercases names', () => {
    expect(slugify('HTTPS_API')).toBe('https_api');
    expect(slugify('UserService')).toBe('userservice');
  });

  it('replaces spaces and special chars with underscores', () => {
    expect(slugify('retry policy')).toBe('retry_policy');
    expect(slugify('error: connection refused')).toBe('error_connection_refused');
  });

  it('preserves hyphens and dots', () => {
    expect(slugify('v2.1.0')).toBe('v2.1.0');
    expect(slugify('rate-limit')).toBe('rate-limit');
  });

  it('collapses multiple underscores', () => {
    expect(slugify('a   b   c')).toBe('a_b_c');
  });

  it('trims leading/trailing underscores', () => {
    expect(slugify(' hello ')).toBe('hello');
    expect(slugify('__test__')).toBe('test');
  });

  it('caps at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBe(80);
  });

  it('keeps letters from any language (Unicode-aware)', () => {
    expect(slugify('café')).toBe('café');
    expect(slugify('naïve')).toBe('naïve');
    expect(slugify('日本語')).toBe('日本語');
  });

  it('replaces punctuation and symbols with underscores', () => {
    expect(slugify('C++')).toBe('c');       // trailing symbols trimmed
    expect(slugify('a/b/c')).toBe('a_b_c');
    expect(slugify('50%')).toBe('50');       // trailing underscore trimmed
  });

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('');
  });
});
