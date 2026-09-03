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
