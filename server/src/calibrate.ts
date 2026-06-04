/**
 * Calibration report CLI (DESIGN.md §4.5, §11). Reads the attempt log and
 * prints per-operation response-time stats plus *advisory* tuning suggestions
 * for threshold.ts. Run against any environment's DB:
 *
 *   DATABASE_URL=sqlite:./data/fact-fluency.sqlite npx tsx server/src/calibrate.ts
 *   DATABASE_URL=postgres://… npx tsx server/src/calibrate.ts   # the live DB
 *
 * Reports nothing actionable until operations have ≥ MIN_CALIBRATION_SAMPLES
 * correct attempts — calibration only makes sense on real usage data.
 */
import { analyzeCalibration } from './engine/calibration';
import { createDb } from './db';

const DATABASE_URL = process.env.DATABASE_URL ?? 'sqlite:./data/fact-fluency.sqlite';
const ms = (n: number | null) => (n == null ? '   —' : `${Math.round(n)}ms`.padStart(6));
const pct = (n: number | null) => (n == null ? '  —' : `${Math.round(n * 100)}%`.padStart(4));

async function main() {
  const db = createDb(DATABASE_URL);
  await db.migrate();
  const attempts = await db.listAllAttempts(0);
  await db.close();

  const report = analyzeCalibration(attempts);

  // eslint-disable-next-line no-console
  const log = console.log;
  log(`\nFact Fluency — calibration report`);
  log(`Attempts analyzed: ${report.totalAttempts}`);
  log(
    `Current constants: K=${report.currentConstants.K}, floor=${report.currentConstants.floorMs}ms, ` +
      `cold-start=${report.currentConstants.coldStartSamples} samples\n`,
  );
  log(`op    attempts  acc   p25    p50    p75    p90   ceiling  <ceil   suggest-K  suggest-ceiling`);
  log(`${'-'.repeat(92)}`);
  for (const o of report.perOperation) {
    log(
      [
        o.operation.padEnd(4),
        String(o.attempts).padStart(8),
        pct(o.accuracy),
        ms(o.p25),
        ms(o.p50),
        ms(o.p75),
        ms(o.p90),
        `${o.currentCeilingMs}ms`.padStart(8),
        pct(o.fastRateUnderCeiling),
        (o.suggestedK == null ? '   —' : o.suggestedK.toFixed(2)).padStart(10),
        (o.suggestedCeilingMs == null ? '   —' : `${o.suggestedCeilingMs}ms`).padStart(16),
      ].join(' '),
    );
  }

  const thin = report.perOperation.filter((o) => !o.enoughData).map((o) => o.operation);
  if (thin.length) {
    log(
      `\nNot enough data yet for: ${thin.join(', ')} ` +
        `(need ≥ 30 correct samples each before suggestions appear).`,
    );
  }
  log('');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
