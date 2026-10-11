import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, deriveBinStatus, fillCategory } from '../src/modules/bins/bin-rules';

describe('fillCategory', () => {
  it.each([
    [0, 'LOW'], [30, 'LOW'], [31, 'MEDIUM'], [60, 'MEDIUM'],
    [61, 'HIGH'], [80, 'HIGH'], [81, 'CRITICAL'], [100, 'CRITICAL'],
  ])('%i%% -> %s', (fill, expected) => {
    expect(fillCategory(fill)).toBe(expected);
  });
});

describe('deriveBinStatus', () => {
  it('uses configured thresholds', () => {
    expect(deriveBinStatus(69, DEFAULT_THRESHOLDS)).toBe('NORMAL');
    expect(deriveBinStatus(70, DEFAULT_THRESHOLDS)).toBe('NEEDS_COLLECTION');
    expect(deriveBinStatus(94, DEFAULT_THRESHOLDS)).toBe('NEEDS_COLLECTION');
    expect(deriveBinStatus(95, DEFAULT_THRESHOLDS)).toBe('OVERFLOWING');
    expect(deriveBinStatus(50, { ...DEFAULT_THRESHOLDS, needsCollectionPercent: 40 })).toBe('NEEDS_COLLECTION');
  });
});
