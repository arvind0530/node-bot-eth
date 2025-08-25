/**
 * Advanced 4-MVE Clustering Trading Bot with 30s Stop-Loss
 * Author: Arvind's Advanced Setup
 * 
 * Strategy:
 * - Entry: MVE-20 cross above/below MVE-200 + all 4 MVEs clustered
 * - Exit: 30s candle closes beyond MVE-200 OR opposite cross
 * - Uses 1min candles for strategy, 30s for stop-loss
 */

import axios from "axios";
import { SMA } from "technicalindicators";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

/* ========= Config ========= */
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const INTERVAL_STRATEGY = "1m"; // Main strategy interval
const INTERVAL_STOPLOSS = "30s"; // Stop-loss monitoring interval

// Moving Averages
const MVE_PERIODS = [20, 50, 100, 200];
const CLUSTER_THRESHOLD_PERCENT = Number(process.env.CLUSTER_THRESHOLD || 0.5); // 0.5% clustering threshold

const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const PORT = Number(process.env.PORT || 4000);

const MONGO_URI = process.env.MONGO_URI || 
  "mongodb+srv://ArvindETH:Arvind2001@tracktohack.2rudkmv.mongodb.net/?retryWrites=true&w=majority&appName=TrackToHack";
const DB_NAME = process.env.DB_NAME || "mveclusterbot";

const API_URL = "https://api.binance.com/api/v3/klines";

/* ========= MongoDB Setup ========= */
let mongoClient, db, positionsCol;

async function connectMongo() {
  if (DRY_RUN) return;
  if (mongoClient) return;

  mongoClient = new MongoClient(MONGO_URI, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  positionsCol = db.collection("positions");

  // Create indexes
  await positionsCol.createIndex({ status: 1, symbol: 1, createdAt: -1 });
  console.log(`[${ts()}] ✅ MongoDB connected (db=${DB_NAME})`);
}

/* ========= State Management ========= */
let isStrategyRunning = false;
let isStopLossRunning = false;
let openPosition = null;

let cached = {
  price: null,
  mve20: null, mve50: null, mve100: null, mve200: null,
  clustered: false,
  clusterGap: null,
  signal: "NONE",
  stopLossTriggered: false,
  lastStrategyTick: null,
  lastStopLossTick: null,
};

/* ========= Utilities ========= */
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function detectCross(prev20, prev200, curr20, curr200) {
  if (prev20 < prev200 && curr20 > curr200) return "GOLDEN";
  if (prev20 > prev200 && curr20 < curr200) return "DEATH";
  return "NONE";
}

// Check if all 4 MVEs are clustered (within threshold % of current price)
function isClustered(mve20, mve50, mve100, mve200, price) {
  if (!mve20 || !mve50 || !mve100 || !mve200 || !price) return { clustered: false, gap: null };
  
  const mveValues = [mve20, mve50, mve100, mve200];
  const maxMve = Math.max(...mveValues);
  const minMve = Math.min(...mveValues);
  const gap = maxMve - minMve;
  const thresholdAmount = price * (CLUSTER_THRESHOLD_PERCENT / 100);
  
  return {
    clustered: gap <= thresholdAmount,
    gap: gap,
    thresholdAmount: thresholdAmount,
    gapPercent: (gap / price) * 100
  };
}

async function fetchCandles(interval, limit = 250) {
  const url = `${API_URL}?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  return data.map(k => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6]
  }));
}

async function restoreOpenPosition() {
  if (DRY_RUN) return;
  const doc = await positionsCol
    .find({ symbol: SYMBOL, status: "OPEN" })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  openPosition = doc[0] || null;
  if (openPosition) {
    console.log(`[${ts()}] 🔄 Restored open position: ${openPosition.positionType} @ ${openPosition.entryPrice}`);
  }
}

/* ========= Trading Functions ========= */
async function openTrade({ positionType, price, mves, clusterInfo }) {
  const trade = {
    symbol: SYMBOL,
    status: "OPEN",
    qty: 1,
    positionType,
    entryPrice: price,
    entryTime: new Date(),
    entryMVEs: mves,
    clusterInfo,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (DRY_RUN) {
    openPosition = { _id: "dryrun", ...trade };
    console.log(`[${ts()}] 🟢 OPEN ${positionType} (DRY_RUN) @ ${price} | Cluster Gap: ${clusterInfo.gapPercent.toFixed(3)}%`);
    return;
  }

  const { insertedId } = await positionsCol.insertOne(trade);
  openPosition = { _id: insertedId, ...trade };
  console.log(`[${ts()}] 🟢 OPEN ${positionType} @ ${price} | Cluster Gap: ${clusterInfo.gapPercent.toFixed(3)}% | ID: ${insertedId}`);
}

async function closeTrade({ price, reason }) {
  if (!openPosition) return;

  const qty = openPosition.qty || 1;
  const isLong = openPosition.positionType === "LONG";
  const pnl = (isLong ? price - openPosition.entryPrice : openPosition.entryPrice - price) * qty;

  if (DRY_RUN) {
    console.log(`[${ts()}] 🔴 CLOSE ${openPosition.positionType} (DRY_RUN) @ ${price} | PnL: ${pnl.toFixed(4)} | Reason: ${reason}`);
    openPosition = null;
    return;
  }

  const result = await positionsCol.findOneAndUpdate(
    { _id: openPosition._id, status: "OPEN" },
    {
      $set: {
        status: "CLOSED",
        exitPrice: price,
        exitTime: new Date(),
        exitReason: reason,
        profitLoss: pnl,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (result?.value) {
    console.log(`[${ts()}] 🔴 CLOSE ${result.value.positionType} @ ${price} | PnL: ${pnl.toFixed(4)} | Reason: ${reason}`);
  }
  openPosition = null;
}

/* ========= Strategy Logic (1-minute) ========= */
async function strategyTick() {
  if (isStrategyRunning) return;
  isStrategyRunning = true;

  try {
    const candles = await fetchCandles(INTERVAL_STRATEGY, 250);
    if (candles.length < 200) {
      console.warn(`[${ts()}] ⚠️ Not enough candles for strategy`);
      return;
    }

    const closes = candles.map(c => c.close);
    const price = closes[closes.length - 1];

    // Calculate all 4 MVEs
    const mve20Arr = SMA.calculate({ period: 20, values: closes });
    const mve50Arr = SMA.calculate({ period: 50, values: closes });
    const mve100Arr = SMA.calculate({ period: 100, values: closes });
    const mve200Arr = SMA.calculate({ period: 200, values: closes });

    if (mve20Arr.length < 2 || mve200Arr.length < 2) {
      console.warn(`[${ts()}] ⚠️ Not enough MVE data points`);
      return;
    }

    // Current and previous values
    const mve20 = mve20Arr[mve20Arr.length - 1];
    const mve50 = mve50Arr[mve50Arr.length - 1];
    const mve100 = mve100Arr[mve100Arr.length - 1];
    const mve200 = mve200Arr[mve200Arr.length - 1];

    const prevMve20 = mve20Arr[mve20Arr.length - 2];
    const prevMve200 = mve200Arr[mve200Arr.length - 2];

    // Check clustering
    const clusterInfo = isClustered(mve20, mve50, mve100, mve200, price);
    
    // Detect crossover
    const signal = detectCross(prevMve20, prevMve200, mve20, mve200);

    // Update cache
    cached = {
      ...cached,
      price,
      mve20, mve50, mve100, mve200,
      clustered: clusterInfo.clustered,
      clusterGap: clusterInfo.gap,
      signal,
      lastStrategyTick: new Date(),
    };

    // Strategy Logic
    if (!openPosition && clusterInfo.clustered) {
      if (signal === "GOLDEN") {
        await openTrade({ 
          positionType: "LONG", 
          price, 
          mves: { mve20, mve50, mve100, mve200 }, 
          clusterInfo 
        });
      } else if (signal === "DEATH") {
        await openTrade({ 
          positionType: "SHORT", 
          price, 
          mves: { mve20, mve50, mve100, mve200 }, 
          clusterInfo 
        });
      }
    } else if (openPosition) {
      // Check for opposite crossover exit
      if ((signal === "DEATH" && openPosition.positionType === "LONG") ||
          (signal === "GOLDEN" && openPosition.positionType === "SHORT")) {
        await closeTrade({ price, reason: "OPPOSITE_CROSSOVER" });
      }
    }

    const posText = openPosition ? `${openPosition.positionType} @ ${openPosition.entryPrice}` : "NONE";
    console.log(
      `[${ts()}] STRATEGY | Price: ${price} | MVE20: ${mve20.toFixed(2)} | MVE200: ${mve200.toFixed(2)} | ` +
      `Clustered: ${clusterInfo.clustered} (${clusterInfo.gapPercent.toFixed(3)}%) | Signal: ${signal} | Position: ${posText}`
    );

  } catch (error) {
    console.error(`[${ts()}] ❌ Strategy tick error:`, error.message);
  } finally {
    isStrategyRunning = false;
  }
}

/* ========= Stop-Loss Logic (30-second) ========= */
async function stopLossTick() {
  if (isStopLossRunning || !openPosition) return;
  isStopLossRunning = true;

  try {
    const candles = await fetchCandles(INTERVAL_STOPLOSS, 100);
    if (candles.length < 200) return;

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    
    // Get 200 MVE for stop-loss reference (using 1m candles)
    const candles1m = await fetchCandles(INTERVAL_STRATEGY, 250);
    const closes1m = candles1m.map(c => c.close);
    const mve200Arr = SMA.calculate({ period: 200, values: closes1m });
    const mve200 = mve200Arr[mve200Arr.length - 1];

    let stopLossTriggered = false;

    if (openPosition.positionType === "LONG" && currentPrice < mve200) {
      stopLossTriggered = true;
      await closeTrade({ price: currentPrice, reason: "STOP_LOSS_BELOW_MVE200" });
    } else if (openPosition.positionType === "SHORT" && currentPrice > mve200) {
      stopLossTriggered = true;
      await closeTrade({ price: currentPrice, reason: "STOP_LOSS_ABOVE_MVE200" });
    }

    cached.stopLossTriggered = stopLossTriggered;
    cached.lastStopLossTick = new Date();

    if (stopLossTriggered) {
      console.log(`[${ts()}] 🛑 STOP-LOSS TRIGGERED | Price: ${currentPrice} | MVE200: ${mve200.toFixed(2)}`);
    }

  } catch (error) {
    console.error(`[${ts()}] ❌ Stop-loss tick error:`, error.message);
  } finally {
    isStopLossRunning = false;
  }
}

/* ========= Express APIs ========= */
const app = express();
app.use(cors());

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    symbol: SYMBOL,
    strategyInterval: INTERVAL_STRATEGY,
    stopLossInterval: INTERVAL_STOPLOSS,
    mvePeriods: MVE_PERIODS,
    clusterThreshold: CLUSTER_THRESHOLD_PERCENT + "%",
    dryRun: DRY_RUN,
    db: DRY_RUN ? "SKIPPED" : (db ? DB_NAME : "DISCONNECTED"),
    position: openPosition ? {
      type: openPosition.positionType,
      entryPrice: openPosition.entryPrice,
      entryTime: openPosition.entryTime
    } : null,
    lastStrategyTick: cached.lastStrategyTick,
    lastStopLossTick: cached.lastStopLossTick,
  });
});

app.get("/api/price", async (req, res) => {
  const stale = !cached.lastStrategyTick || 
    Date.now() - new Date(cached.lastStrategyTick).getTime() > 70000;
  
  if (stale) await strategyTick();
  
  res.json({
    symbol: SYMBOL,
    price: cached.price,
    mve20: cached.mve20,
    mve50: cached.mve50,
    mve100: cached.mve100,
    mve200: cached.mve200,
    clustered: cached.clustered,
    clusterGap: cached.clusterGap,
    signal: cached.signal,
    positionOpen: Boolean(openPosition),
    positionType: openPosition?.positionType || null,
    lastStrategyTick: cached.lastStrategyTick,
    lastStopLossTick: cached.lastStopLossTick,
  });
});

app.get("/api/orders/history", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    
    const limit = Math.min(Number(req.query.limit || 100), 1000);
    const trades = await positionsCol
      .find({ symbol: SYMBOL })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/positions/open", async (req, res) => {
  try {
    if (DRY_RUN) return res.json(openPosition ? [openPosition] : []);
    
    const trades = await positionsCol
      .find({ symbol: SYMBOL, status: "OPEN" })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(trades);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/pnl/total", async (req, res) => {
  try {
    if (DRY_RUN) return res.json({ totalPnL: 0, count: 0 });
    
    const result = await positionsCol.aggregate([
      { $match: { symbol: SYMBOL, status: "CLOSED" } },
      { $group: { _id: null, totalPnL: { $sum: "$profitLoss" }, count: { $sum: 1 } } }
    ]).toArray();
    
    const totalPnL = result.length ? result[0].totalPnL : 0;
    const count = result.length ? result[0].count : 0;
    
    res.json({ totalPnL: Number(totalPnL.toFixed(6)), count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ========= Manual Triggers ========= */
app.get("/api/tick/strategy", async (req, res) => {
  await strategyTick();
  res.json({ ok: true, lastTick: cached.lastStrategyTick });
});

app.get("/api/tick/stoploss", async (req, res) => {
  await stopLossTick();
  res.json({ ok: true, lastTick: cached.lastStopLossTick });
});

/* ========= Bootstrap & Scheduling ========= */
async function bootstrap() {
  if (!DRY_RUN) {
    await connectMongo();
    await restoreOpenPosition();
  } else {
    console.log(`[${ts()}] 🧪 DRY_RUN mode enabled`);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[${ts()}] ✅ MVE Cluster Bot API running on http://0.0.0.0:${PORT}`);
  });

  // Strategy tick every 1 minute (aligned to minute boundary)
  const now = Date.now();
  const msToMinute = 60000 - (now % 60000);
  setTimeout(() => {
    strategyTick();
    setInterval(strategyTick, 60000); // Every 1 minute
  }, msToMinute);

  // Stop-loss tick every 30 seconds
  setTimeout(() => {
    setInterval(stopLossTick, 30000); // Every 30 seconds
  }, 5000); // Start after 5 seconds
}

process.on("SIGINT", async () => {
  console.log("\n[SHUTDOWN] Gracefully closing bot...");
  try {
    if (mongoClient) await mongoClient.close();
  } finally {
    process.exit(0);
  }
});

bootstrap();
