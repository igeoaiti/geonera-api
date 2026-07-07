import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { createBunWebSocket } from "hono/bun";
import { db } from "./db";
import { jobs, cronSchedules, configs, predictions, trades } from "./db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { 
  startTickSimulator, 
  stopTickSimulator, 
  forexEvents, 
  placeOrder, 
  closePosition, 
  generateAIPrediction, 
  initializeConfigs,
  getLatestTick
} from "./services/forex";
import { startRabbitMQConsumers, checkRabbitMQHealth } from "./rabbitmq";
import { logger } from "./logger";

const app = new Hono();

// Enable CORS for all origins (especially localhost dashboard)
app.use("*", cors());

// Create Bun WebSocket adapter
const { upgradeWebSocket, websocket } = createBunWebSocket();

// Welcome / Root Endpoint
app.get("/", (c) => {
  return c.json({
    name: "geonera-api",
    version: "1.0.0",
    status: "running",
    communication_modes: {
      simplex: "Server-Sent Events at /api/simplex/ticks",
      half_duplex: "REST API at /api/*",
      full_duplex: "WebSockets at /ws"
    }
  });
});

// Health check
app.get("/health", async (c) => {
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch (e: any) {
    logger.error(e, "[API] DB Connection check failed");
  }

  const rmqOk = await checkRabbitMQHealth();

  return c.json({
    status: dbOk && rmqOk ? "healthy" : "degraded",
    services: {
      database: dbOk ? "connected" : "disconnected",
      rabbitmq: rmqOk ? "connected" : "disconnected",
      tickSimulator: "running"
    },
    timestamp: new Date().toISOString()
  });
});

// =========================================================================
// Simplex Mode: SSE Tick Feed
// =========================================================================
app.get("/api/simplex/ticks", (c) => {
  return streamSSE(c, async (stream) => {
    logger.info("[SSE] Client connected to live tick stream");

    const onTick = (tick: any) => {
      void stream.writeSSE({
        data: JSON.stringify(tick),
        event: "tick",
        id: String(Date.now()),
      });
    };

    forexEvents.on("tick", onTick);

    stream.onAbort(() => {
      logger.info("[SSE] Client disconnected from tick stream");
      forexEvents.off("tick", onTick);
    });

    // Write initial tick states immediately
    const symbols = ["EURUSD", "GBPUSD", "USDJPY"];
    for (const sym of symbols) {
      await stream.writeSSE({
        data: JSON.stringify(getLatestTick(sym)),
        event: "tick",
        id: String(Date.now()),
      });
    }

    // Keep-alive heartbeat loop
    while (true) {
      await stream.sleep(15000);
      try {
        await stream.writeSSE({
          data: "ping",
          event: "ping",
        });
      } catch (err) {
        break; // Stream closed
      }
    }
  });
});

// =========================================================================
// Half-Duplex Mode: HTTP REST Endpoints
// =========================================================================

// Config API
app.get("/api/config", async (c) => {
  const allConfigs = await db.select().from(configs);
  const configMap: Record<string, string> = {};
  allConfigs.forEach((cfg) => {
    configMap[cfg.key] = cfg.value;
  });
  return c.json(configMap);
});

app.post("/api/config", async (c) => {
  const body = await c.req.json();
  for (const key of Object.keys(body)) {
    const value = String(body[key]);
    await db
      .insert(configs)
      .values({ key, value })
      .onConflictDoUpdate({
        target: configs.key,
        set: { value, updatedAt: new Date() }
      });
  }
  return c.json({ message: "Configurations updated successfully" });
});

// Predictions History API
app.get("/api/predictions", async (c) => {
  const results = await db
    .select()
    .from(predictions)
    .orderBy(desc(predictions.createdAt))
    .limit(50);
  return c.json(results);
});

// Trades API
app.get("/api/trades", async (c) => {
  const results = await db
    .select()
    .from(trades)
    .orderBy(desc(trades.createdAt))
    .limit(50);
  return c.json(results);
});

app.post("/api/trades", async (c) => {
  const body = await c.req.json();
  if (!body.symbol || !body.action || !body.volume) {
    return c.json({ error: "Missing symbol, action, or volume" }, 400);
  }
  const trade = await placeOrder(body.symbol, body.action, Number(body.volume));
  return c.json(trade, 201);
});

app.delete("/api/trades/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const trade = await closePosition(id);
    return c.json(trade);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Scheduler Jobs and Schedules Integration (Half-Duplex)
app.get("/api/scheduler/jobs", async (c) => {
  // Aggregate job counts by status
  const counts = await db
    .select({
      status: jobs.status,
      count: sql<number>`count(*)::int`,
    })
    .from(jobs)
    .groupBy(jobs.status)
    .execute();

  const stats = counts.reduce(
    (acc, curr) => {
      acc[curr.status] = curr.count;
      return acc;
    },
    { pending: 0, running: 0, completed: 0, failed: 0 } as Record<string, number>
  );

  // Fetch 15 most recent jobs
  const recentJobs = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(15);

  // Fetch all cron schedules
  const schedules = await db.select().from(cronSchedules);

  return c.json({
    stats,
    schedules,
    recentJobs,
  });
});

app.post("/api/scheduler/jobs", async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "Missing required field: 'name'" }, 400);

  const [inserted] = await db
    .insert(jobs)
    .values({
      name: body.name,
      triggerMethod: body.triggerMethod || "RABBITMQ",
      payload: body.payload || {},
      priority: body.priority ?? 0,
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : new Date(),
      status: "pending",
    })
    .returning();

  return c.json({ message: "Job enqueued successfully", job: inserted }, 201);
});

app.post("/api/scheduler/cron-schedules/trigger", async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "Missing required field: 'name'" }, 400);

  const [schedule] = await db.select().from(cronSchedules).where(eq(cronSchedules.name, body.name));
  if (!schedule) return c.json({ error: `Cron schedule "${body.name}" not found` }, 404);

  const [triggeredJob] = await db
    .insert(jobs)
    .values({
      name: schedule.name,
      triggerMethod: schedule.triggerMethod,
      payload: {
        ...(schedule.payload || {}),
        body: {
          triggeredManually: true,
          triggeredAt: new Date().toISOString(),
        },
      },
      scheduledAt: new Date(),
      status: "pending",
      priority: 5,
    })
    .returning();

  return c.json({ message: `Schedule "${schedule.name}" triggered`, job: triggeredJob }, 201);
});

// =========================================================================
// Full-Duplex Mode: WebSockets
// =========================================================================

interface ClientSession {
  ws: any;
  subscribedSymbols: Set<string>;
}

const activeSessions = new Set<ClientSession>();

// Listen to forex ticks and stream them via websockets to subscribed clients
forexEvents.on("tick", (tick) => {
  activeSessions.forEach((session) => {
    if (session.subscribedSymbols.has(tick.symbol)) {
      try {
        session.ws.send(
          JSON.stringify({
            type: "tick",
            symbol: tick.symbol,
            data: tick,
          })
        );
      } catch (err) {
        // Handle failed writes
      }
    }
  });
});

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    const session: ClientSession = {
      ws: null,
      subscribedSymbols: new Set<string>(["EURUSD", "GBPUSD", "USDJPY"]), // default all
    };

    return {
      onOpen(event, ws) {
        session.ws = ws;
        activeSessions.add(session);
        logger.info("[WebSocket] Connection opened");
        ws.send(
          JSON.stringify({
            type: "connection_ack",
            message: "Connected to Geonera Full-Duplex WebSocket Engine",
          })
        );
      },
      async onMessage(event, ws) {
        try {
          const payload = JSON.parse(String(event.data));
          logger.info({ payload }, "[WebSocket] Message received");

          switch (payload.type) {
            case "subscribe":
              if (payload.symbol) {
                session.subscribedSymbols.add(payload.symbol);
                ws.send(JSON.stringify({ type: "info", message: `Subscribed to ${payload.symbol} ticks` }));
              }
              break;
            case "unsubscribe":
              if (payload.symbol) {
                session.subscribedSymbols.delete(payload.symbol);
                ws.send(JSON.stringify({ type: "info", message: `Unsubscribed from ${payload.symbol} ticks` }));
              }
              break;
            case "analyze":
              if (payload.symbol) {
                ws.send(JSON.stringify({ type: "status", message: `AI generating indicators for ${payload.symbol}...` }));
                const result = await generateAIPrediction(payload.symbol);
                ws.send(JSON.stringify({ type: "analysis_result", symbol: payload.symbol, data: result }));
              }
              break;
            case "execute_trade":
              if (payload.symbol && payload.action && payload.volume) {
                ws.send(JSON.stringify({ type: "status", message: `Placing ${payload.action} order...` }));
                const trade = await placeOrder(payload.symbol, payload.action, Number(payload.volume));
                ws.send(JSON.stringify({ type: "trade_executed", data: trade }));
              }
              break;
            case "close_trade":
              if (payload.tradeId) {
                ws.send(JSON.stringify({ type: "status", message: "Closing trade position..." }));
                const trade = await closePosition(payload.tradeId);
                ws.send(JSON.stringify({ type: "trade_closed", data: trade }));
              }
              break;
            default:
              ws.send(JSON.stringify({ type: "error", message: `Unknown command type: ${payload.type}` }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "error", message: `Failed to parse message: ${err.message}` }));
        }
      },
      onClose(event, ws) {
        activeSessions.delete(session);
        logger.info("[WebSocket] Connection closed");
      },
    };
  })
);

// =========================================================================
// Server Bootstrap & Start
// =========================================================================
const PORT = parseInt(process.env.PORT || "3001", 10);

async function bootstrap() {
  logger.info("[Server] Bootstrapping Geonera API backend...");
  await initializeConfigs();
  await startRabbitMQConsumers();
  startTickSimulator();
}

bootstrap()
  .then(() => {
    logger.info(`[Server] Geonera backend running at http://localhost:${PORT}`);
  })
  .catch((err) => {
    logger.error(err, "[Server] Bootstrap process failed");
  });

// Run with Bun native server (providing websocket capabilities)
const server = Bun.serve({
  fetch: app.fetch,
  websocket,
  port: PORT,
});
