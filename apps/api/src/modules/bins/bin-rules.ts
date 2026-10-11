import type { BinStatus } from '@prisma/client';

export interface Thresholds {
  needsCollectionPercent: number;
  overflowingPercent: number;
  criticalPercent: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  needsCollectionPercent: 70,
  overflowingPercent: 95,
  criticalPercent: 81,
};

export type FillCategory = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Spec categories: Low 0-30, Medium 31-60, High 61-80, Critical 81-100. */
export function fillCategory(fill: number): FillCategory {
  if (fill <= 30) return 'LOW';
  if (fill <= 60) return 'MEDIUM';
  if (fill <= 80) return 'HIGH';
  return 'CRITICAL';
}

/** Status derived from fill level. OUT_OF_SERVICE is a manual state and is handled by the caller. */
export function deriveBinStatus(fill: number, t: Thresholds): Exclude<BinStatus, 'OUT_OF_SERVICE'> {
  if (fill >= t.overflowingPercent) return 'OVERFLOWING';
  if (fill >= t.needsCollectionPercent) return 'NEEDS_COLLECTION';
  return 'NORMAL';
}
