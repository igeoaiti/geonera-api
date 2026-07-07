import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL || "postgres://sans:!PQssw0rd123@localhost:5432/geonera";

// Configure postgres pool
export const queryClient = postgres(databaseUrl, { 
  max: 10, 
  idle_timeout: 30, 
  connect_timeout: 10 
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
