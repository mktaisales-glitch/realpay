/* ######################################################################
 * Schedule maths. Dates are ISO calendar dates (YYYY-MM-DD) in UTC.
 * When a milestone is released, every later milestone's forecast moves
 * by the same number of days the release was early or late.
 * ###################################################################### */

const DAY_MS = 86_400_000;

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return toIsoDate(
    new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS),
  );
}

export function daysBetween(
  fromIsoDate: string,
  toIsoDateValue: string,
): number {
  return Math.round(
    (Date.parse(`${toIsoDateValue}T00:00:00Z`) -
      Date.parse(`${fromIsoDate}T00:00:00Z`)) /
      DAY_MS,
  );
}

export type PlannedWindow = { start: string; end: string };

/** Lays milestones end to end from a start date. */
export function planSequential(
  startIsoDate: string,
  durationsInDays: number[],
): PlannedWindow[] {
  const windows: PlannedWindow[] = [];
  let cursor = startIsoDate;
  for (const duration of durationsInDays) {
    const end = addDays(cursor, duration - 1);
    windows.push({ start: cursor, end });
    cursor = addDays(end, 1);
  }
  return windows;
}

export type ForecastRow = {
  seq: number;
  forecastStart: string;
  forecastEnd: string;
};

/**
 * Returns the new forecasts after milestone `releasedSeq` finishes on
 * `actualEnd`. Earlier milestones and the released one keep their dates
 * (the released one gets `actualEnd`); later ones shift by the delta.
 */
export function shiftAfterRelease<T extends ForecastRow>(
  rows: T[],
  releasedSeq: number,
  actualEnd: string,
): { rows: T[]; deltaDays: number } {
  const released = rows.find((row) => row.seq === releasedSeq);
  if (!released) {
    return { rows, deltaDays: 0 };
  }
  const deltaDays = daysBetween(released.forecastEnd, actualEnd);
  return {
    deltaDays,
    rows: rows.map((row) => {
      if (row.seq === releasedSeq) {
        return {
          ...row,
          forecastEnd: actualEnd,
          forecastStart:
            daysBetween(row.forecastStart, actualEnd) < 0
              ? actualEnd
              : row.forecastStart,
        };
      }
      if (row.seq > releasedSeq) {
        return {
          ...row,
          forecastStart: addDays(row.forecastStart, deltaDays),
          forecastEnd: addDays(row.forecastEnd, deltaDays),
        };
      }
      return row;
    }),
  };
}
