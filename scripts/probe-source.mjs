import { readCount, readSourceObservation, SOURCE, validateObservation } from "./collect.mjs";

// Probe the upstream directly every time. Existing hourly history must never
// make this succeed without a fresh source response, and this probe writes none.
try {
  const raw = process.env.COLLECT_PROVIDER === "websocket"
    ? await readCount({ withTimestamp: true, omitOrigin: true }) : await readSourceObservation();
  const observation = validateObservation(raw, new Date());
  console.log(JSON.stringify({ source: SOURCE, ...observation }));
} catch (error) {
  console.error(`Source probe failed: ${error.message}`);
  process.exitCode = 1;
}
