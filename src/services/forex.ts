import { EventEmitter } from "events";
import { db } from "../db";
import { predictions, trades, configs } from "../db/schema";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

export const forexEvents = new EventEmitter();

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  high: number;
  low: number;
  timestamp: string;
}

// Initial prices
const PRICES: Record<string, { price: number; high: number; low: number; spread: number }> = {
  EURUSD: { price: 1.0850, high: 1.0890, low: 1.0810, spread: 0.0002 },
  GBPUSD: { price: 1.2720, high: 1.2780, low: 1.2670, spread: 0.0003 },
  USDJPY: { price: 158.40, high: 159.20, low: 157.60, spread: 0.02 },
};

// Start random walk tick simulator
let tickInterval: Timer | null = null;

export function startTickSimulator() {
  if (tickInterval) return;
  
  logger.info("[ForexEngine] Starting tick simulator...");
  tickInterval = setInterval(() => {
    Object.keys(PRICES).forEach((symbol) => {
      const current = PRICES[symbol];
      // Random walk change
      const pct = (Math.random() - 0.5) * 0.0006; // +/- 0.03% change
      const delta = current.price * pct;
      current.price = parseFloat((current.price + delta).toFixed(symbol === "USDJPY" ? 3 : 5));
      
      // Update high/low
      if (current.price > current.high) current.high = current.price;
      if (current.price < current.low) current.low = current.price;

      const bid = parseFloat((current.price - current.spread / 2).toFixed(symbol === "USDJPY" ? 3 : 5));
      const ask = parseFloat((current.price + current.spread / 2).toFixed(symbol === "USDJPY" ? 3 : 5));

      const tick: Tick = {
        symbol,
        bid,
        ask,
        high: current.high,
        low: current.low,
        timestamp: new Date().toISOString(),
      };

      // Broadcast tick
      forexEvents.emit("tick", tick);
      forexEvents.emit(`tick:${symbol}`, tick);

      // Update profit of open trades in database
      void updateOpenTradesProfit(symbol, bid, ask);
    });
  }, 1000);
}

export function stopTickSimulator() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info("[ForexEngine] Tick simulator stopped.");
  }
}

// Get the latest tick for a symbol
export function getLatestTick(symbol: string): Tick {
  const current = PRICES[symbol] || PRICES.EURUSD;
  const bid = parseFloat((current.price - current.spread / 2).toFixed(symbol === "USDJPY" ? 3 : 5));
  const ask = parseFloat((current.price + current.spread / 2).toFixed(symbol === "USDJPY" ? 3 : 5));
  return {
    symbol,
    bid,
    ask,
    high: current.high,
    low: current.low,
    timestamp: new Date().toISOString(),
  };
}

// Update PnL for active positions
async function updateOpenTradesProfit(symbol: string, bid: number, ask: number) {
  try {
    const openPositions = await db.select().from(trades).where(eq(trades.status, "OPEN"));
    const symbolPositions = openPositions.filter((t) => t.symbol === symbol);

    for (const position of symbolPositions) {
      let profit = 0;
      const multiplier = symbol === "USDJPY" ? 1000 : 100000;
      if (position.action === "BUY") {
        profit = (bid - position.entryPrice) * position.volume * multiplier;
      } else {
        profit = (position.entryPrice - ask) * position.volume * multiplier;
      }
      
      profit = parseFloat(profit.toFixed(2));

      await db
        .update(trades)
        .set({ profit })
        .where(eq(trades.id, position.id));
      
      // Emit position updates
      forexEvents.emit(`trade_update:${position.id}`, { ...position, profit });
    }
  } catch (err) {
    // Avoid noisy logging in tick loop
  }
}

// Generate an AI prediction and save it
export async function generateAIPrediction(symbol: string) {
  const tick = getLatestTick(symbol);
  const midPrice = (tick.bid + tick.ask) / 2;

  // Simulate indicator generation
  const rsi = Math.floor(30 + Math.random() * 45); // 30 to 75
  const macdHistogram = (Math.random() - 0.5) * 0.002;
  const bollingerBands = {
    upper: midPrice * 1.002,
    lower: midPrice * 0.998,
  };

  let direction: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (rsi < 42 || macdHistogram > 0.0005) {
    direction = "BUY";
  } else if (rsi > 58 || macdHistogram < -0.0005) {
    direction = "SELL";
  }

  const confidence = parseFloat((0.55 + Math.random() * 0.4).toFixed(2)); // 0.55 - 0.95
  const targetMultiplier = direction === "BUY" ? 1.003 : direction === "SELL" ? 0.997 : 1.0;
  const slMultiplier = direction === "BUY" ? 0.998 : direction === "SELL" ? 1.002 : 1.0;
  const tpMultiplier = direction === "BUY" ? 1.006 : direction === "SELL" ? 0.994 : 1.0;

  const targetPrice = parseFloat((midPrice * targetMultiplier).toFixed(symbol === "USDJPY" ? 3 : 5));
  const stopLoss = parseFloat((midPrice * slMultiplier).toFixed(symbol === "USDJPY" ? 3 : 5));
  const takeProfit = parseFloat((midPrice * tpMultiplier).toFixed(symbol === "USDJPY" ? 3 : 5));

  const [inserted] = await db
    .insert(predictions)
    .values({
      symbol,
      direction,
      confidence,
      price: midPrice,
      targetPrice,
      stopLoss,
      takeProfit,
    })
    .returning();

  logger.info({ symbol, direction, confidence }, "[AI Model] Generated new prediction");

  const result = {
    prediction: inserted,
    indicators: {
      rsi,
      macd: macdHistogram > 0 ? "bullish_crossover" : "bearish_crossover",
      bollinger: bollingerBands,
    },
  };

  forexEvents.emit("prediction", result);
  return result;
}

// Execute trade order
export async function placeOrder(symbol: string, action: "BUY" | "SELL", volume: number) {
  const tick = getLatestTick(symbol);
  // BUY opens at Ask, SELL opens at Bid
  const entryPrice = action === "BUY" ? tick.ask : tick.bid;

  const [trade] = await db
    .insert(trades)
    .values({
      symbol,
      action,
      volume,
      entryPrice,
      status: "OPEN",
      profit: 0,
    })
    .returning();

  logger.info({ id: trade.id, symbol, action, entryPrice }, "[TradingEngine] Position opened");
  forexEvents.emit("trade_opened", trade);
  return trade;
}

// Close trade position
export async function closePosition(tradeId: string) {
  const [position] = await db.select().from(trades).where(eq(trades.id, tradeId));
  if (!position || position.status === "CLOSED") {
    throw new Error("Position not found or already closed");
  }

  const tick = getLatestTick(position.symbol);
  // BUY closes at Bid, SELL closes at Ask
  const exitPrice = position.action === "BUY" ? tick.bid : tick.ask;

  const multiplier = position.symbol === "USDJPY" ? 1000 : 100000;
  let finalProfit = 0;
  if (position.action === "BUY") {
    finalProfit = (exitPrice - position.entryPrice) * position.volume * multiplier;
  } else {
    finalProfit = (position.entryPrice - exitPrice) * position.volume * multiplier;
  }
  finalProfit = parseFloat(finalProfit.toFixed(2));

  const [closed] = await db
    .update(trades)
    .set({
      status: "CLOSED",
      exitPrice,
      profit: finalProfit,
      closedAt: new Date(),
    })
    .where(eq(trades.id, tradeId))
    .returning();

  logger.info({ id: closed.id, profit: finalProfit }, "[TradingEngine] Position closed");
  forexEvents.emit("trade_closed", closed);
  return closed;
}

// Initialize system configs if empty
export async function initializeConfigs() {
  try {
    const existing = await db.select().from(configs);
    if (existing.length === 0) {
      logger.info("[Configs] Seeding default configurations...");
      await db.insert(configs).values([
        { key: "trading_mode", value: "DEMO" },
        { key: "auto_trade", value: "false" },
        { key: "risk_multiplier", value: "1.0" },
        { key: "ai_threshold", value: "0.75" },
        { key: "active_pairs", value: "EURUSD,GBPUSD,USDJPY" },
      ]);
    }
  } catch (err) {
    logger.error(err, "[Configs] Seed failed");
  }
}
