// 农历（阴历）换算 —— 1900–2100
//
// 数据来源与原理：
//   每年用一个 32 位整数压缩编码，即中文互联网上流传最广的经典数据表
//   （原始出处：Jea Yang 的 calendar.js）。
//
//   ⚠️ 这张表里 1933 / 1996 / 2057 / 2060 四个年份，经典版本与官方数据不一致
//   （各差一天），本文件已按**香港天文台的官方《公曆與農曆日期對照表》**逐一修正：
//   把 1901–2100 全部 2474 个农历月首与 HKO 数据比对后，只剩这 4 处差异，
//   反推出正确编码后改掉，现在逐月完全一致（见 test-lunar.mjs）。
//   另外 1933-07-22/23 这一天，HKO 与 lunardate 等库仍有一天分歧，
//   本项目以 HKO 官方表为准。
//
//   位含义：
//     0x8000 … 0x0010   从正月到十二月，12 个二进制位；置 1 = 该月 30 天，0 = 29 天
//     0x000F            闰月是几月，0 = 本年无闰月
//     0x10000           闰月本身是 30 天还是 29 天
//
//   ⚠️ 这张表**极易抄错**，抄错一个十六进制位就会让某一整年的日期全错。
//   所以 test-lunar.mjs 会拿 Node 自带的 ICU 中文历法
//   （Intl.DateTimeFormat 的 zh-CN-u-ca-chinese）逐日交叉验证 1900–2100 的
//   每一天，而不是抽查几天。
//
// 换算基准：公历 1900-01-31 == 农历 1900 年正月初一。
// 所有计算都在 UTC 里做（只用"天数差"，不受时区与夏令时影响）。

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0, // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
];

export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

const DAY_MS = 86400000;
// 公历 1900-01-31 是农历 1900 年正月初一
const BASE_UTC = Date.UTC(1900, 0, 31);

const GAN = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"];
const ZHI = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];
const ZODIAC = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
const MONTH_NAMES = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];
const DAY_NAMES = [
  "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "廿一", "廿二", "廿三", "廿四", "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

function info(year) {
  return LUNAR_INFO[year - MIN_YEAR];
}

// 该年闰几月（0 = 无闰月）
export function leapMonth(year) {
  return info(year) & 0xf;
}

// 闰月的天数（没有闰月返回 0）
export function leapDays(year) {
  if (!leapMonth(year)) return 0;
  return info(year) & 0x10000 ? 30 : 29;
}

// 该农历年的总天数
export function lunarYearDays(year) {
  let sum = 348; // 12 个月 × 29 天的下限
  for (let bit = 0x8000; bit > 0x8; bit >>= 1) {
    if (info(year) & bit) sum++;
  }
  return sum + leapDays(year);
}

// 某个农历月的天数（month 取 1–12）
export function lunarMonthDays(year, month) {
  return info(year) & (0x10000 >> month) ? 30 : 29;
}

/**
 * 公历 → 农历
 * @returns {{year:number, month:number, day:number, isLeap:boolean} | null}
 */
export function solar2lunar(y, m, d) {
  const target = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(target)) return null;
  // 校验公历日期本身是否真实存在（避免 2023-02-30 被 Date 自动进位）
  const back = new Date(target);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }

  let offset = Math.round((target - BASE_UTC) / DAY_MS);
  if (offset < 0) return null;

  let ly = MIN_YEAR;
  let days = 0;
  for (; ly <= MAX_YEAR; ly++) {
    days = lunarYearDays(ly);
    if (offset < days) break;
    offset -= days;
  }
  if (ly > MAX_YEAR) return null;

  const leap = leapMonth(ly);
  let isLeap = false;
  let lm = 1;
  for (; lm <= 12 && offset > 0; lm++) {
    if (leap > 0 && lm === leap + 1 && !isLeap) {
      // 走到闰月：先退回来，把"闰 X 月"当成一次独立迭代
      --lm;
      isLeap = true;
      days = leapDays(ly);
    } else {
      days = lunarMonthDays(ly, lm);
    }
    if (isLeap && lm === leap + 1) isLeap = false;
    offset -= days;
  }
  // 恰好落在闰月边界上
  if (offset === 0 && leap > 0 && lm === leap + 1) {
    if (isLeap) {
      isLeap = false;
    } else {
      isLeap = true;
      --lm;
    }
  }
  if (offset < 0) {
    offset += days;
    --lm;
  }

  return { year: ly, month: lm, day: offset + 1, isLeap };
}

/**
 * 农历 → 公历
 * @returns {{year:number, month:number, day:number} | null} month 为 1–12
 */
export function lunar2solar(ly, lm, ld, isLeap = false) {
  if (!Number.isInteger(ly) || ly < MIN_YEAR || ly > MAX_YEAR) return null;
  if (!Number.isInteger(lm) || lm < 1 || lm > 12) return null;
  if (!Number.isInteger(ld) || ld < 1 || ld > 30) return null;

  const leap = leapMonth(ly);
  if (isLeap && leap !== lm) return null; // 该年没有这个闰月
  if (ld > (isLeap ? leapDays(ly) : lunarMonthDays(ly, lm))) return null;

  let offset = 0;
  for (let i = MIN_YEAR; i < ly; i++) offset += lunarYearDays(i);
  for (let i = 1; i < lm; i++) {
    offset += lunarMonthDays(ly, i);
    if (leap === i) offset += leapDays(ly); // 闰月紧跟在同名月之后
  }
  if (isLeap) offset += lunarMonthDays(ly, lm);
  offset += ld - 1;

  const ts = BASE_UTC + offset * DAY_MS;
  if (offset < 0) return null;
  const d = new Date(ts);
  // 超出表格覆盖范围（2100 年底之后）时给出 null
  if (d.getUTCFullYear() > MAX_YEAR + 1) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * 把「农历某月某日」放到指定农历年里，返回对应的公历日期。
 * 两种"这一年放不进去"的情况做兜底（也是大众实际习惯）：
 *   1. 原本是闰月，但这一年没有这个闰月 → 按同名平月算
 *   2. 原本是三十，但这一年的该月只有 29 天 → 按该月最后一天（廿九）算
 */
export function lunarInYear(lunarYear, month, day, wantLeap = false) {
  const tries = wantLeap ? [true, false] : [false];
  for (const leap of tries) {
    const direct = lunar2solar(lunarYear, month, day, leap);
    if (direct) return direct;
    const last = lunar2solar(lunarYear, month, 30, leap)
      ? 30
      : lunar2solar(lunarYear, month, 29, leap)
        ? 29
        : null;
    if (last) return lunar2solar(lunarYear, month, last, leap);
  }
  return null;
}

// 干支（如"癸卯"）与生肖（如"兔"）
export function ganzhiOf(lunarYear) {
  const g = GAN[(lunarYear - 4) % 10];
  const z = ZHI[(lunarYear - 4) % 12];
  return g + z;
}
export function zodiacOf(lunarYear) {
  return ZODIAC[(lunarYear - 4) % 12];
}

// 中文表述：闰二月廿八 / 正月初一
export function formatLunar({ month, day, isLeap }) {
  if (!month || !day) return "";
  return (isLeap ? "闰" : "") + MONTH_NAMES[month - 1] + "月" + DAY_NAMES[day - 1];
}
