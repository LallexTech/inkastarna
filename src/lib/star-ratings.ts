export type StarRatingSummary = {
  average: number | null;
  total: number;
  count: number;
};

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function retainedRatings(ratings: number[]) {
  const sorted = [...ratings].sort((a, b) => a - b);
  if (sorted.length <= 5) return sorted;

  const center = median(sorted);
  const deviations = sorted.map((rating) => Math.abs(rating - center)).sort((a, b) => a - b);
  const mad = median(deviations);

  if (mad === 0) {
    const outliers = sorted.filter((rating) => Math.abs(rating - center) >= 2);
    if (outliers.length !== 1) return sorted;

    const candidate = outliers[0];
    const remaining = sorted.filter((rating) => rating !== candidate);
    if (remaining[remaining.length - 1] - remaining[0] <= 1) return remaining;
    return sorted;
  }

  const retained = sorted.filter((rating) => Math.abs(0.6745 * (rating - center) / mad) <= 3.5);
  return retained.length ? retained : sorted;
}

export function summarizeStarRatings(ratings: number[]): StarRatingSummary {
  if (!ratings.length) return { average: null, total: 0, count: 0 };

  const retained = retainedRatings(ratings);
  const total = retained.reduce((sum, rating) => sum + rating, 0);
  return { average: total / retained.length, total, count: retained.length };
}
