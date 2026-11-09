import cron from 'node-cron';
import { config } from './config.js';
import { prisma } from './db.js';
import { createApp } from './app.js';
import { runBilling } from './services/billing.js';
import { runAutomaticReminders } from './services/reminders.js';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`Leadway Estate API on http://localhost:${config.port}`));

  if (config.enableScheduler) {
    const bill = (why) =>
      runBilling()
        .then((r) => console.log(`[billing:${why}] created ${r.created}, skipped ${r.skipped}`))
        .catch((err) => console.error(`[billing:${why}]`, err));
    bill('boot');
    // Nightly at 00:10 Lagos time. Idempotent, so it also catches anyone missed.
    cron.schedule('10 0 * * *', () => bill('nightly'), { timezone: config.timezone });
    // Weekly reminders to members who owe, if switched on (Reminders page). Checked daily at 09:05.
    cron.schedule('5 9 * * *', () =>
      runAutomaticReminders()
        .then((r) => r && console.log(`[reminders] sent ${r.reminded}`))
        .catch((err) => console.error('[reminders]', err)), { timezone: config.timezone });
  }

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
