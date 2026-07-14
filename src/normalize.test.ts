import { describe, it, expect } from 'vitest';
import { normalize } from './normalize.js';

describe('normalize', () => {
  it('lowercases names', () => {
    expect(normalize('HTTPS_API')).toBe('https_api');
    expect(normalize('UserService')).toBe('userservice');
  });

  it('replaces spaces and special chars with underscores', () => {
    expect(normalize('retry policy')).toBe('retry_policy');
    expect(normalize('error: connection refused')).toBe('error_connection_refused');
  });

  it('preserves hyphens and dots', () => {
    expect(normalize('v2.1.0')).toBe('v2.1.0');
    expect(normalize('rate-limit')).toBe('rate-limit');
  });

  it('collapses multiple underscores', () => {
    expect(normalize('a   b   c')).toBe('a_b_c');
  });

  it('trims leading/trailing underscores', () => {
    expect(normalize(' hello ')).toBe('hello');
    expect(normalize('__test__')).toBe('test');
  });

  it('caps at 80 chars', () => {
    const long = 'a'.repeat(200);
    expect(normalize(long).length).toBe(80);
  });

  it('handles unicode letters (ä, ö, ü, ß, §)', () => {
    expect(normalize('Prüfung')).toBe('prüfung');
    expect(normalize('§42')).toBe('§42');
    expect(normalize('Größe')).toBe('größe');
  });

  it('returns empty string for empty input', () => {
    expect(normalize('')).toBe('');
  });
});
