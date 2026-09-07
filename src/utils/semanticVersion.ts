export function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(a[i]) - Number(b[i]);
    if (difference) return difference;
  }
  if (!a[4] && !b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const aParts = a[4].split(".");
  const bParts = b[4].split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const x = aParts[i];
    const y = bParts[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/u.test(x);
    const ny = /^\d+$/u.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x.localeCompare(y);
  }
  return 0;
}
