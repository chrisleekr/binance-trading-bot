import { formatPercent } from '@/shared/lib/format';

export const score = (n: number): string => formatPercent(n);
