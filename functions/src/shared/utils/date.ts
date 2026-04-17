const DR_TZ = "America/Santo_Domingo";

/** Returns today's date in DR timezone as "YYYY-MM-DD". */
export function getToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DR_TZ });
}

/** Returns yesterday's date in DR timezone as "YYYY-MM-DD". */
export function getYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString("en-CA", { timeZone: DR_TZ });
}
