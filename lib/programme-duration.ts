type ProgrammeDuration = {
  duration_value?: string | number | null;
  duration_min_value?: string | number | null;
  duration_max_value?: string | number | null;
  duration_unit?: string | null;
};

export function suggestedCompletionDate(startDate: string, programme?: ProgrammeDuration) {
  const rawDuration = programme?.duration_max_value || programme?.duration_value || programme?.duration_min_value;
  const duration = Math.round(Number(rawDuration));
  const unit = programme?.duration_unit;
  if (!startDate || !Number.isFinite(duration) || duration <= 0 || !["days", "weeks", "months", "years"].includes(unit || "")) return "";

  const date = new Date(`${startDate}T00:00:00Z`);
  if (unit === "days") date.setUTCDate(date.getUTCDate() + duration);
  if (unit === "weeks") date.setUTCDate(date.getUTCDate() + (duration * 7));
  if (unit === "months") {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + duration);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }
  if (unit === "years") {
    const month = date.getUTCMonth();
    date.setUTCFullYear(date.getUTCFullYear() + duration);
    if (date.getUTCMonth() !== month) date.setUTCDate(0);
  }
  return date.toISOString().slice(0, 10);
}
