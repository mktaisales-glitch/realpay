import { escapeHtml, formatDay, raw } from "./format.js";

/* ######################################################################
 * Schedule chart. The outlined bar is the plan agreed at the start; the
 * filled bar is the forecast, which moves when a milestone is paid late
 * or its proof is rejected. Plain SVG, no chart library.
 * ###################################################################### */

const DAY_MS = 86_400_000;
const ROW = 34;
const LABEL_WIDTH = 210;
const CHART_WIDTH = 760;
const TOP = 26;

/** @param {string} isoDate */
function toDay(isoDate) {
  return Math.round(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/**
 * @param {Array<{ seq: number, title: string, status: string,
 *   schedule: { plannedStart: string, plannedEnd: string, forecastStart: string, forecastEnd: string, slipDays: number } }>} milestones
 * @param {string} today YYYY-MM-DD
 */
export function ganttSvg(milestones, today) {
  if (milestones.length === 0) return raw("");
  const todayDay = toDay(today);
  const days = milestones.flatMap(({ schedule }) => [
    toDay(schedule.plannedStart),
    toDay(schedule.forecastStart),
    toDay(schedule.plannedEnd) + 1,
    toDay(schedule.forecastEnd) + 1,
  ]);
  const first = Math.min(...days, todayDay) - 1;
  const last = Math.max(...days, todayDay + 1) + 1;
  const span = Math.max(last - first, 7);
  const scale = (CHART_WIDTH - LABEL_WIDTH - 12) / span;
  const x = (day) => LABEL_WIDTH + (day - first) * scale;
  const height = TOP + milestones.length * ROW + 8;

  const parts = [];

  // Week ticks.
  const tickEvery = span > 45 ? 14 : 7;
  for (let day = first + 1; day < last; day += 1) {
    if ((day - first - 1) % tickEvery !== 0) continue;
    const date = new Date(day * DAY_MS).toISOString().slice(0, 10);
    parts.push(
      `<line class="g-grid" x1="${x(day)}" x2="${x(day)}" y1="${TOP - 6}" y2="${height}"/>`,
      `<text class="g-tick" x="${x(day) + 3}" y="${TOP - 10}">${escapeHtml(formatDay(date))}</text>`,
    );
  }

  for (const [index, milestone] of milestones.entries()) {
    const { schedule } = milestone;
    const y = TOP + index * ROW;
    const plannedX = x(toDay(schedule.plannedStart));
    const plannedW =
      (toDay(schedule.plannedEnd) + 1 - toDay(schedule.plannedStart)) * scale;
    const forecastX = x(toDay(schedule.forecastStart));
    const forecastW =
      (toDay(schedule.forecastEnd) + 1 - toDay(schedule.forecastStart)) * scale;
    const status = milestone.status.toLowerCase();
    const title = `${milestone.seq}. ${milestone.title}`;
    const label = title.length > 30 ? `${title.slice(0, 29)}…` : title;
    const slip =
      schedule.slipDays > 0
        ? `<text class="g-slip" x="${forecastX + forecastW + 6}" y="${y + 21}">+${schedule.slipDays}d</text>`
        : "";

    parts.push(
      `<g><title>${escapeHtml(title)}: planned ${escapeHtml(formatDay(schedule.plannedStart))}–${escapeHtml(formatDay(schedule.plannedEnd))}, forecast ${escapeHtml(formatDay(schedule.forecastStart))}–${escapeHtml(formatDay(schedule.forecastEnd))}</title>`,
      `<text class="g-label" x="0" y="${y + 21}">${escapeHtml(label)}</text>`,
      `<rect class="g-planned" x="${plannedX}" y="${y + 6}" width="${plannedW}" height="22" rx="6"/>`,
      `<rect class="g-bar g-${status}" x="${forecastX}" y="${y + 10}" width="${forecastW}" height="14" rx="5"/>`,
      slip,
      `</g>`,
    );
  }

  const todayX = x(todayDay);
  parts.push(
    `<line class="g-today" x1="${todayX}" x2="${todayX}" y1="${TOP - 4}" y2="${height}"/>`,
    `<text class="g-today-label" x="${todayX + 4}" y="${height - 2}">Today</text>`,
  );

  return raw(
    `<svg viewBox="0 0 ${CHART_WIDTH} ${height + 6}" role="img" aria-label="Schedule: planned versus forecast dates for each milestone">${parts.join("")}</svg>`,
  );
}
