export function parseAllowedIds(
  value: string | undefined,
): ReadonlySet<string> {
  if (!value?.trim()) return new Set();
  const ids = value.split(",").map((id) => id.trim());
  if (
    ids.some(
      (id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)),
    )
  )
    return new Set();
  return new Set(ids);
}
