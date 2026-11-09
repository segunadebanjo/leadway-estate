import { prisma } from '../db.js';

// Settings an executive can change in the app. Each key has defaults, so a
// value saved by an older version still reads with every field present.
const DEFAULTS = {
  reminders: {
    auto: false, // send reminders automatically every week
    weekday: 1, // 0 Sunday … 6 Saturday (Lagos time)
    minDaysOverdue: 7, // only bills at least this many days past due
    minAmount: 0, // kobo; ignore tiny balances
    email: true,
    sms: false,
  },
};

export async function getSetting(key) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return { ...DEFAULTS[key], ...(row?.value || {}) };
}

export async function saveSetting(key, value) {
  const merged = { ...(await getSetting(key)), ...value };
  await prisma.setting.upsert({ where: { key }, create: { key, value: merged }, update: { value: merged } });
  return merged;
}
