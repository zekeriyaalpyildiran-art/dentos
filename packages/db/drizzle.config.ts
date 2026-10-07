import type { Config } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

export default {
  schema: "./src/schema",
  out: "./migrations",
  driver: "pg",
  dbCredentials: {
    connectionString,
  },
  migrations: {
    prefix: "timestamp",
  },
} satisfies Config;
