import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** Schema versions, applied in order; `PRAGMA user_version` records how many ran. */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  (db) =>
    db.exec(`
      -- The v1 cache mixed user fields into symbols; v2 keeps those in the vault and re-pulls bars.
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS bars;
      CREATE TABLE symbols (
        key        TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        ticker     TEXT NOT NULL,
        name       TEXT,
        exchange   TEXT,
        currency   TEXT,
        timezone   TEXT,
        kind       TEXT,
        synced_at  INTEGER,
        sync_error TEXT,
        first_t    INTEGER,
        last_t     INTEGER
      );
      CREATE TABLE bars (
        key TEXT    NOT NULL,
        t   INTEGER NOT NULL,
        o   REAL    NOT NULL,
        h   REAL    NOT NULL,
        l   REAL    NOT NULL,
        c   REAL    NOT NULL,
        v   REAL,
        adj REAL    NOT NULL DEFAULT 1,
        PRIMARY KEY (key, t)
      ) WITHOUT ROWID;
      CREATE TABLE stats (
        key         TEXT PRIMARY KEY,
        computed_at INTEGER NOT NULL,
        json        TEXT NOT NULL
      );
    `),
  (db) =>
    db.exec(`
      -- What each notify rule looked like at the last sync; see src/lib/alerts.ts.
      CREATE TABLE alert_state (
        rule      TEXT    NOT NULL,
        key       TEXT    NOT NULL,
        state     INTEGER,
        fired_bar INTEGER,
        fired_at  INTEGER,
        PRIMARY KEY (rule, key)
      ) WITHOUT ROWID;
    `),
  (db) =>
    db.exec(`
      -- One row per vault on a shared instance ('' is the root vault). Both are caches: the next
      -- sync recomputes stats, and alerts record silently once before they fire again.
      DROP TABLE stats;
      DROP TABLE alert_state;
      CREATE TABLE stats (
        vault       TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        computed_at INTEGER NOT NULL,
        json        TEXT    NOT NULL,
        PRIMARY KEY (vault, key)
      );
      CREATE TABLE alert_state (
        vault     TEXT    NOT NULL,
        rule      TEXT    NOT NULL,
        key       TEXT    NOT NULL,
        state     INTEGER,
        fired_bar INTEGER,
        fired_at  INTEGER,
        PRIMARY KEY (vault, rule, key)
      ) WITHOUT ROWID;
    `),
  (db) =>
    db.exec(`
      -- The latest price per symbol from the 5-minute quote polling (src/lib/quotes.ts). Not bars:
      -- today's unfinished daily bar is built from it in memory only.
      CREATE TABLE quotes (
        key        TEXT PRIMARY KEY,
        price      REAL    NOT NULL,
        time       INTEGER NOT NULL,
        day_high   REAL,
        day_low    REAL,
        session    TEXT    NOT NULL,
        fetched_at INTEGER NOT NULL
      );
    `),
  (db) =>
    db.exec(`
      -- Traffic monitoring (src/lib/usage.ts), kept 90 days. day: the instance's local day as unix
      -- seconds at UTC midnight, like bars.t. visitor: salted hash of the client IP, never the IP.
      CREATE TABLE traffic (
        day     INTEGER NOT NULL,
        origin  TEXT    NOT NULL,
        kind    TEXT    NOT NULL,
        path    TEXT    NOT NULL,
        visitor TEXT    NOT NULL,
        login   TEXT    NOT NULL,
        n       INTEGER NOT NULL,
        last    INTEGER NOT NULL,
        PRIMARY KEY (day, origin, kind, path, visitor, login)
      ) WITHOUT ROWID;
      CREATE TABLE upstream (
        day      INTEGER NOT NULL,
        source   TEXT    NOT NULL,
        requests INTEGER NOT NULL,
        failures INTEGER NOT NULL,
        limited  INTEGER NOT NULL,
        PRIMARY KEY (day, source)
      ) WITHOUT ROWID;
      -- Which usage limits already notified the owner on a day
      CREATE TABLE usage_alerts (
        kind TEXT    NOT NULL,
        day  INTEGER NOT NULL,
        PRIMARY KEY (kind, day)
      ) WITHOUT ROWID;
    `),
  (db) =>
    db.exec(`
      -- Bounded rows: paths are routes (src/lib/traffic.ts routeOf), and visitors are their own
      -- table with at most MAX_VISITORS per day and origin (src/lib/usage.ts); the rest is '(其他)'.
      DROP TABLE traffic;
      CREATE TABLE traffic (
        day    INTEGER NOT NULL,
        origin TEXT    NOT NULL,
        kind   TEXT    NOT NULL,
        path   TEXT    NOT NULL,
        n      INTEGER NOT NULL,
        PRIMARY KEY (day, origin, kind, path)
      ) WITHOUT ROWID;
      CREATE TABLE visitors (
        day     INTEGER NOT NULL,
        origin  TEXT    NOT NULL,
        visitor TEXT    NOT NULL,
        login   TEXT    NOT NULL,
        n       INTEGER NOT NULL,
        last    INTEGER NOT NULL,
        PRIMARY KEY (day, origin, visitor, login)
      ) WITHOUT ROWID;
    `),
  (db) =>
    db.exec(`
      -- The trading day's open and volume as the source reports them with a quote, and the regular
      -- session on the exchange's clock (HHMM-HHMM or 24x7) for the countdown to the bar's close.
      ALTER TABLE quotes ADD COLUMN day_open REAL;
      ALTER TABLE quotes ADD COLUMN day_volume REAL;
      ALTER TABLE symbols ADD COLUMN hours TEXT;
    `),
  (db) =>
    db.exec(`
      -- The trading calendar that comes with the hours: days without trading (20261126,20261225)
      -- and days with other hours (0930-1300:20261127;dayoff:20250109), last year's and later.
      ALTER TABLE symbols ADD COLUMN holidays TEXT;
      ALTER TABLE symbols ADD COLUMN corrections TEXT;
    `),
  (db) =>
    db.exec(`
      -- What each symbol is, as its source describes it (src/lib/profiles.ts): slow facts fetched
      -- weekly, shared like bars. json stays from the last fetch that worked; tried_at and error
      -- are the last attempt. A description's Chinese translation is made when someone asks for it
      -- and stands for the text whose hash it carries.
      CREATE TABLE profiles (
        key        TEXT PRIMARY KEY,
        json       TEXT,
        fetched_at INTEGER,
        tried_at   INTEGER NOT NULL,
        error      TEXT
      );
      CREATE TABLE translations (
        key   TEXT PRIMARY KEY,
        hash  TEXT    NOT NULL,
        text  TEXT    NOT NULL,
        model TEXT    NOT NULL,
        at    INTEGER NOT NULL
      );
    `),
];

const dbFile = () => process.env.HEBI8_DB ?? path.join(process.cwd(), "data", "hebi8.db");

/** The cache directory: the database and anything else that a re-sync rebuilds. */
export const dataDir = () => path.dirname(dbFile());

function open(): Database.Database {
  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      MIGRATIONS[i](db);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}

const globalForDb = globalThis as unknown as { hebi8Db?: Database.Database };

export function getDb(): Database.Database {
  globalForDb.hebi8Db ??= open();
  return globalForDb.hebi8Db;
}
