export const fuzzyScore = (query: string, target: string) => {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  if (t.includes(q)) return 500 - t.indexOf(q);

  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    score += 10 - Math.min(ti, 9);
    qi += 1;
  }

  return qi === q.length ? score : 0;
};
