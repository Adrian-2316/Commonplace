import { buildApp } from "./app.js";
import { connect, migrate } from "./db.js";
import { seedDemo } from "./seed.js";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Set ${name}`);
  return v;
};

const db = connect(env("DATABASE_URL"));
await migrate(db);
if (process.env.SEED_DEMO === "true") await seedDemo(db);

const origin = env("APP_ORIGIN", "http://localhost:5173");
const { app, collab } = await buildApp(db, {
  origin,
  secureCookies: origin.startsWith("https://"),
  webDir: process.env.WEB_DIR,
  logger: true,
  trustedProxies: process.env.TRUSTED_PROXIES,
});
collab.attach(app.server);
await app.listen({ host: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    collab.hocuspocus.flushPendingStores();
    await new Promise((r) => setTimeout(r, 500));
    await app.close();
    await db.end();
    process.exit(0);
  });
}
