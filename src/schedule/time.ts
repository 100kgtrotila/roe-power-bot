const kyiv = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Kyiv",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function localParts(timestamp: number): Record<string, string> {
  return Object.fromEntries(
    kyiv.formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
}
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === date
  );
}
export function getKyivDates(now: number): { today: string; tomorrow: string } {
  const parts = localParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return { today, tomorrow };
}
export function getOutageStart(
  date: string,
  startMinute: number,
): number | null {
  if (
    !isValidDate(date) ||
    !Number.isInteger(startMinute) ||
    startMinute < 0 ||
    startMinute >= 1440
  )
    return null;
  const nominal = Date.parse(`${date}T00:00:00Z`) + startMinute * 60000;
  // Discover offsets from IANA data on either side of a possible transition.
  const offsets = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const instant = nominal + delta;
    const parts = localParts(instant);
    offsets.add(
      Date.parse(
        `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`,
      ) - instant,
    );
  }
  const matches: number[] = [];
  for (const offset of offsets) {
    const candidate = nominal - offset;
    const parts = localParts(candidate);
    if (
      `${parts.year}-${parts.month}-${parts.day}` === date &&
      Number(parts.hour) * 60 + Number(parts.minute) === startMinute
    )
      matches.push(candidate);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
