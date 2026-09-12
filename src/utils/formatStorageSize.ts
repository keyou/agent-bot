export function formatStorageSize(bytes: number): string {
  const normalized = Math.max(0, Math.round(bytes));
  if (normalized < 1_024) return `${normalized} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = normalized / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(precision))} ${units[unitIndex]}`;
}
