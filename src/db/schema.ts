import { pgSchema, pgTable, uuid, text, timestamp, integer, boolean, jsonb, doublePrecision } from "drizzle-orm/pg-core";

// =========================================================================
// Scheduler Schema & Tables (for monitoring & control)
// =========================================================================
export const schedulerSchema = pgSchema("scheduler");

export const jobStatusEnum = schedulerSchema.enum("job_status", ["pending", "running", "completed", "failed"]);

export const jobs = schedulerSchema.table("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  triggerMethod: text("trigger_method").default("RABBITMQ").notNull(),
  status: jobStatusEnum("status").default("pending").notNull(),
  payload: jsonb("payload").$type<{
    queue?: string;
    exchange?: string;
    routingKey?: string;
    body?: Record<string, unknown> | string;
    retentionDays?: number;
  }>(),
  priority: integer("priority").default(0).notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const cronSchedules = schedulerSchema.table("cron_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  triggerMethod: text("trigger_method").default("RABBITMQ").notNull(),
  cronExpression: text("cron_expression").notNull(),
  payload: jsonb("payload").$type<{
    queue?: string;
    exchange?: string;
    routingKey?: string;
    body?: Record<string, unknown> | string;
    retentionDays?: number;
  }>(),
  isActive: boolean("is_active").default(true).notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// =========================================================================
// Trading Schema & Tables (for Geonera API platform features)
// =========================================================================
export const configs = pgTable("configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const predictions = pgTable("predictions", {
  id: uuid("id").defaultRandom().primaryKey(),
  symbol: text("symbol").notNull(),
  direction: text("direction").notNull(), // BUY, SELL, HOLD
  confidence: doublePrecision("confidence").notNull(), // 0.0 to 1.0
  price: doublePrecision("price").notNull(),
  targetPrice: doublePrecision("target_price").notNull(),
  stopLoss: doublePrecision("stop_loss").notNull(),
  takeProfit: doublePrecision("take_profit").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const trades = pgTable("trades", {
  id: uuid("id").defaultRandom().primaryKey(),
  symbol: text("symbol").notNull(),
  action: text("action").notNull(), // BUY, SELL
  volume: doublePrecision("volume").notNull(), // lot size e.g. 0.1, 1.0
  entryPrice: doublePrecision("entry_price").notNull(),
  exitPrice: doublePrecision("exit_price"),
  status: text("status").default("OPEN").notNull(), // OPEN, CLOSED
  profit: doublePrecision("profit").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
