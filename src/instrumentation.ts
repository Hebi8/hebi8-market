export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // before anything reads a config: the old `conditions` lists move into `alerts` once
    const { migrateAllConditions } = await import("./lib/alerts");
    migrateAllConditions();
    const { startScheduler } = await import("./lib/scheduler");
    const { startQuotes } = await import("./lib/quotes");
    const { startUsage } = await import("./lib/usage");
    const { startProbes } = await import("./lib/telegram");
    startScheduler();
    startQuotes();
    startUsage();
    startProbes();
  }
}
