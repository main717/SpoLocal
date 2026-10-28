/**
 * Which stats range the Home page opens with.
 *
 * One preference shared by the Home switcher and the Settings modal, so both
 * stay in sync without either controller owning the other.
 */
const RANGE_KEY = 'spolocal_home_range';

export const HOME_RANGES = [
    { key: 'day', label: 'Day', title: 'Today', period: 'today', days: 1 },
    { key: 'week', label: 'Week', title: 'This week', period: 'this week', days: 7 },
    { key: 'month', label: 'Month', title: 'This month', period: 'this month', days: 30 },
    { key: 'year', label: 'Year', title: 'This year', period: 'this year', days: 365 },
];

export function home_range_def(key) {
    return HOME_RANGES.find((row) => row.key === key) || HOME_RANGES[1];
}

export function home_range() {
    try {
        return home_range_def(localStorage.getItem(RANGE_KEY)).key;
    } catch (e) {
        return 'week';
    }
}

export function set_home_range(key) {
    const def = home_range_def(key);
    try {
        localStorage.setItem(RANGE_KEY, def.key);
    } catch (e) {}
    return def.key;
}
