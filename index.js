/**
 * Advanced 4-MVE Clustering Trading Bot with 30s Stop-Loss
 * Author: Arvind's Advanced Setup
 * * Strategy:
 * - Entry: MVE-50 cross above/below MVE-200 + all 4 MVEs clustered (UPDATED)
 * - Enhanced: 1min Golden Gate Break (MVE-50 crosses MVE-200 after clustering)
 * - Reference: 3min MVE-200 for broader trend understanding (not direct entry/exit)
 * - Exit: 30s candle closes beyond 1min MVE-200 OR opposite cross on 1min
 * - Uses 1min candles for strategy, 30s for stop-loss, 3min for reference
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
const INTERVAL_REFERENCE = "3m"; // New: 3-minute interval for reference MVE-200

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
  mve20: null, mve50: null, mve100: null, mve200: null, // 1m MVEs
  mve200_3m: null, // New: 3m MVE-200 reference
  clustered: false,
  clusterGap: null,
  signal: "NONE",
  stopLossTriggered: false,
  lastStrategyTick: null,
  lastStopLossTick: null,
};

/* ========= Utilities ========= */
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

function detectCross(prevFast, prevSlow, currFast, currSlow) {
  if (prevFast < prevSlow && currFast > currSlow) return "GOLDEN";
  if (prevFast > prevSlow && currFast < currSlow) return "DEATH";
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
  try {
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
  } catch (error) {
    console.error(`[${ts()}] ❌ Error fetching candles for ${interval}:`, error.message);
    return [];
  }
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
async function openTrade({ positionType, price, mves, clusterInfo, mve200_3m_ref }) {
  const trade = {
    symbol: SYMBOL,
    status: "OPEN",
    qty: 1, // Example quantity
    positionType,
    entryPrice: price,
    entryTime: new Date(),
    entryMVEs: mves,
    clusterInfo,
    mve200_3m_at_entry: mve200_3m_ref, // New: Store 3m MVE-200 at entry
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (DRY_RUN) {
    openPosition = { _id: "dryrun", ...trade };
    console.log(`[${ts()}] 🟢 OPEN ${positionType} (DRY_RUN) @ ${price} | Cluster Gap: ${clusterInfo.gapPercent.toFixed(3)}% | 3m MVE200 Ref: ${mve200_3m_ref?.toFixed(2) || 'N/A'}`);
    return;
  }

  const { insertedId } = await positionsCol.insertOne(trade);
  openPosition = { _id: insertedId, ...trade };
  console.log(`[${ts()}] 🟢 OPEN ${positionType} @ ${price} | Cluster Gap: ${clusterInfo.gapPercent.toFixed(3)}% | 3m MVE200 Ref: ${mve200_3m_ref?.toFixed(2) || 'N/A'} | ID: ${insertedId}`);
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
    const candles1m = await fetchCandles(INTERVAL_STRATEGY, 250);
    const candles3m = await fetchCandles(INTERVAL_REFERENCE, 250); // Fetch 3m candles for reference

    if (candles1m.length < 200) {
      console.warn(`[${ts()}] ⚠️ Not enough 1m candles for strategy`);
      return;
    }
    if (candles3m.length < 200) {
        console.warn(`[${ts()}] ⚠️ Not enough 3m candles for reference MVE`);
        // We can still proceed with 1m strategy, but the 3m reference will be null
    }

    const closes1m = candles1m.map(c => c.close);
    const price = closes1m[closes1m.length - 1];

    // Calculate all 4 MVEs for 1m interval
    const mve20Arr = SMA.calculate({ period: 20, values: closes1m });
    const mve50Arr = SMA.calculate({ period: 50, values: closes1m });
    const mve100Arr = SMA.calculate({ period: 100, values: closes1m });
    const mve200Arr = SMA.calculate({ period: 200, values: closes1m });

    if (mve50Arr.length < 2 || mve200Arr.length < 2) { // Changed MVE20Arr to MVE50Arr here for the crossover check
      console.warn(`[${ts()}] ⚠️ Not enough 1m MVE data points for MVE50/MVE200 crossover`);
      return;
    }

    // Current and previous 1m MVE values
    const mve20 = mve20Arr[mve20Arr.length - 1];
    const mve50 = mve50Arr[mve50Arr.length - 1];
    const mve100 = mve100Arr[mve100Arr.length - 1];
    const mve200 = mve200Arr[mve200Arr.length - 1];

    // Previous MVE values for crossover detection
    const prevMve50 = mve50Arr[mve50Arr.length - 2]; // UPDATED: Use prev MVE-50
    const prevMve200 = mve200Arr[mve200Arr.length - 2];

    // Calculate 3m MVE-200 for reference
    let mve200_3m = null;
    if (candles3m.length >= 200) {
        const closes3m = candles3m.map(c => c.close);
        const mve200_3m_Arr = SMA.calculate({ period: 200, values: closes3m });
        if (mve200_3m_Arr.length > 0) {
            mve200_3m = mve200_3m_Arr[mve200_3m_Arr.length - 1];
        }
    }

    // Check clustering for all 4 MVEs
    const clusterInfo = isClustered(mve20, mve50, mve100, mve200, price);
    
    // Detect crossover for 1m MVE-50 and MVE-200 (UPDATED)
    const signal = detectCross(prevMve50, prevMve200, mve50, mve200);

    // Update cache
    cached = {
      ...cached,
      price,
      mve20, mve50, mve100, mve200, // 1m MVEs
      mve200_3m, // 3m MVE-200 reference
      clustered: clusterInfo.clustered,
      clusterGap: clusterInfo.gap,
      signal,
      lastStrategyTick: new Date(),
    };

    // Strategy Logic - Sunil Minglani inspired "Golden Gate Break"
    // Only consider opening a position if no position is open AND MVEs are clustered
    if (!openPosition && clusterInfo.clustered) {
      if (signal === "GOLDEN") {
        // Golden Gate Break: MVE-50 crosses MVE-200 upwards after clustering
        await openTrade({ 
          positionType: "LONG", 
          price, 
          mves: { mve20, mve50, mve100, mve200 }, 
          clusterInfo,
          mve200_3m_ref: mve200_3m 
        });
      } else if (signal === "DEATH") {
        // Death Gate Break: MVE-50 crosses MVE-200 downwards after clustering
        await openTrade({ 
          positionType: "SHORT", 
          price, 
          mves: { mve20, mve50, mve100, mve200 }, 
          clusterInfo,
          mve200_3m_ref: mve200_3m 
        });
      }
    } else if (openPosition) {
      // Check for opposite crossover exit on 1m candles
      if ((signal === "DEATH" && openPosition.positionType === "LONG") ||
          (signal === "GOLDEN" && openPosition.positionType === "SHORT")) {
        await closeTrade({ price, reason: "OPPOSITE_CROSSOVER" });
      }
    }

    const posText = openPosition ? `${openPosition.positionType} @ ${openPosition.entryPrice}` : "NONE";
    console.log(
      `[${ts()}] STRATEGY | Price: ${price} | MVE50(1m): ${mve50.toFixed(2)} | MVE200(1m): ${mve200.toFixed(2)} | ` + // UPDATED log
      `MVE200(3m): ${mve200_3m?.toFixed(2) || 'N/A'} | Clustered: ${clusterInfo.clustered} (${clusterInfo.gapPercent.toFixed(3)}%) | ` +
      `Signal: ${signal} | Position: ${posText}`
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
    const candles30s = await fetchCandles(INTERVAL_STOPLOSS, 100);
    if (candles30s.length === 0) {
        console.warn(`[${ts()}] ⚠️ Not enough 30s candles for stop-loss`);
        return;
    }

    const currentPrice = candles30s[candles30s.length - 1].close;
    
    // Get 1-minute 200 MVE for stop-loss reference
    const candles1m = await fetchCandles(INTERVAL_STRATEGY, 250);
    if (candles1m.length < 200) {
        console.warn(`[${ts()}] ⚠️ Not enough 1m candles for 200 MVE stop-loss reference`);
        return;
    }
    const closes1m = candles1m.map(c => c.close);
    const mve200Arr = SMA.calculate({ period: 200, values: closes1m });
    const mve200_1m_ref = mve200Arr[mve200Arr.length - 1];

    let stopLossTriggered = false;

    // Stop-loss: 30s candle closes beyond 1m MVE-200
    if (openPosition.positionType === "LONG" && currentPrice < mve200_1m_ref) {
      stopLossTriggered = true;
      await closeTrade({ price: currentPrice, reason: "STOP_LOSS_BELOW_MVE200_1M" });
    } else if (openPosition.positionType === "SHORT" && currentPrice > mve200_1m_ref) {
      stopLossTriggered = true;
      await closeTrade({ price: currentPrice, reason: "STOP_LOSS_ABOVE_MVE200_1M" });
    }

    cached.stopLossTriggered = stopLossTriggered;
    cached.lastStopLossTick = new Date();

    if (stopLossTriggered) {
      console.log(`[${ts()}] 🛑 STOP-LOSS TRIGGERED | Current Price (30s): ${currentPrice} | 1m MVE200: ${mve200_1m_ref.toFixed(2)}`);
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
    referenceInterval: INTERVAL_REFERENCE,
    mvePeriods: MVE_PERIODS,
    clusterThreshold: CLUSTER_THRESHOLD_PERCENT + "%",
    dryRun: DRY_RUN,
    db: DRY_RUN ? "SKIPPED" : (db ? DB_NAME : "DISCONNECTED"),
    position: openPosition ? {
      type: openPosition.positionType,
      entryPrice: openPosition.entryPrice,
      entryTime: openPosition.entryTime,
      mve200_3m_at_entry: openPosition.mve200_3m_at_entry
    } : null,
    lastStrategyTick: cached.lastStrategyTick,
    lastStopLossTick: cached.lastStopLossTick,
  });
});

app.get("/api/price", async (req, res) => {
  // If strategyTick hasn't run recently, run it to get updated cached data
  const stale = !cached.lastStrategyTick || 
    Date.now() - new Date(cached.lastStrategyTick).getTime() > 70000;
  
  if (stale) await strategyTick();
  
  res.json({
    symbol: SYMBOL,
    price: cached.price,
    mve20: cached.mve20,
    mve50: cached.mve50,
    mve100: cached.mve100,
    mve200: cached.mve200, // 1m MVEs
    mve200_3m: cached.mve200_3m, // 3m MVE-200 reference
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
