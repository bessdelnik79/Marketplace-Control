const DAY_MS = 86400000;
const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

const pad = value => String(value).padStart(2, '0');
const dateOnly = date => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) throw new Error('financial_invalid_date');
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || dateOnly(date) !== value) throw new Error('financial_invalid_date');
  return date;
};

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function mondayOnOrBefore(date) {
  const weekday = date.getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

export function moscowDate(instant = new Date()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error('financial_invalid_date');
  return dateOnly(new Date(date.getTime() + MOSCOW_OFFSET_MS));
}

export function annualFinancialWeeks(eventInstant = new Date()) {
  const eventDate = parseDate(moscowDate(eventInstant));
  const previousYear = eventDate.getUTCFullYear() - 1;
  const lastDay = new Date(Date.UTC(previousYear, eventDate.getUTCMonth() + 1, 0)).getUTCDate();
  const lookback = new Date(Date.UTC(previousYear, eventDate.getUTCMonth(), Math.min(eventDate.getUTCDate(), lastDay)));
  const firstMonday = mondayOnOrBefore(lookback);
  const currentMonday = mondayOnOrBefore(eventDate);
  const lastClosedSunday = addDays(currentMonday, -1);
  const weeks = [];
  for (let start = firstMonday; start <= lastClosedSunday; start = addDays(start, 7)) {
    weeks.push({ weekStart: dateOnly(start), weekEnd: dateOnly(addDays(start, 6)) });
  }
  return {
    lookbackDate: dateOnly(lookback),
    lastClosedSunday: dateOnly(lastClosedSunday),
    weeks
  };
}

export function weeklyFinancialWindow(instant = new Date(), freshWeekCount = 5) {
  if (!Number.isInteger(freshWeekCount) || freshWeekCount < 1 || freshWeekCount > 53) {
    throw new Error('financial_invalid_week_count');
  }
  const localDate = parseDate(moscowDate(instant));
  const currentMonday = mondayOnOrBefore(localDate);
  const dueWeekStart = addDays(currentMonday, -7);
  return {
    scheduleBoundary: dateOnly(currentMonday),
    dueWeek: { weekStart: dateOnly(dueWeekStart), weekEnd: dateOnly(addDays(dueWeekStart, 6)) },
    window: { dateFrom: dateOnly(addDays(dueWeekStart, -7 * (freshWeekCount - 1))), dateTo: dateOnly(addDays(dueWeekStart, 6)) }
  };
}
