export const MAX_PROJECTED_BINDING_ENTRIES = 8_192;

/** Decide multiplicative projection capacity without performing the allocation. */
export function withinProjectedBindingCapacity(
  parentCount: number,
  descendantCount: number,
): boolean {
  return (
    Number.isSafeInteger(parentCount) &&
    parentCount >= 0 &&
    Number.isSafeInteger(descendantCount) &&
    descendantCount >= 0 &&
    (parentCount === 0 ||
      descendantCount <= Math.floor(MAX_PROJECTED_BINDING_ENTRIES / parentCount))
  );
}

/** Safely accumulate independent projection batches against the one global allocation bound. */
export function accumulateProjectedBindingCapacity(
  currentCount: number,
  parentCount: number,
  descendantCount: number,
): number | undefined {
  if (
    !Number.isSafeInteger(currentCount) ||
    currentCount < 0 ||
    currentCount > MAX_PROJECTED_BINDING_ENTRIES ||
    !withinProjectedBindingCapacity(parentCount, descendantCount)
  ) {
    return undefined;
  }
  const projectedCount = parentCount * descendantCount;
  return projectedCount <= MAX_PROJECTED_BINDING_ENTRIES - currentCount
    ? currentCount + projectedCount
    : undefined;
}
