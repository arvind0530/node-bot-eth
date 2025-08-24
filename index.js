/**
 * Advanced EMA + RSI + Volume Bot with MongoDB Atlas (native driver)
 * Author: Arvind's Setup
 */

import express from "express";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import axios from "axios";
import WebSocket from "ws";
import fs from "fs-extra";
import { RSI, EMA } from "technicalindicators";
import cors from "cors";
dotenv.config();

const {
  MONGO_URI,
  DB_NAME,
  SYMBOL,
  TIMEFRAME_MINUTES,
  EMA_SMALL,
  EMA_HIGH,
  PORT,
} = process.env;

const app = express();
// Allow all origins (for development)
app.use(cors());
app.use(express.json());

// ===== DB Setup =====
let db, ordersCol, stateCol;
const client = new MongoClient(MONGO_URI);

async function connectDB() {
  await client.connect();
  db = client.db(DB_NAME);
  ordersCol = db.collection("orders");
  stateCol = db.collection("botState");
  console.log("✅ Connected to MongoDB Atlas");
}
await connectDB();

// ===== Bot State =====
let inPosition = false;
let equity = 1000; // starting equity
let currentTrade = null;
let closes = [];
let volumes = [];
let rsiValues = [];
let emaFast = [];
let emaSlow = [];

async function loadState() {
  const state = await stateCol.findOne({ _id: "bot" });
  if (state) {
    inPosition = state.inPosition;
    equity = state.equity;
    currentTrade = state.currentTrade;
    console.log("🔄 State restored from DB:", state);
  }
}
async function saveState() {
  await stateCol.updateOne(
    { _id: "bot" },
    { $set: { inPosition, equity, currentTrade } },
    { upsert: true }
  );
}
await loadState();

// ===== Indicators =====
function updateIndicators(close, volume) {
  closes.push(close);
  volumes.push(volume);

  if (closes.length > EMA_HIGH) {
    emaFast = EMA.calculate({ period: parseInt(EMA_SMALL), values: closes });
    emaSlow = EMA.calculate({ period: parseInt(EMA_HIGH), values: closes });
    rsiValues = RSI.calculate({ period: 14, values: closes });
  }
}

function generateSignal() {
  if (emaFast.length === 0 || emaSlow.length === 0 || rsiValues.length === 0)
    return null;

  const lastFast = emaFast[emaFast.length - 1];
  const lastSlow = emaSlow[emaSlow.length - 1];
  const rsi = rsiValues[rsiValues.length - 1];
  const vol = volumes[volumes.length - 1];

  // Buy signal
  if (lastFast > lastSlow && rsi > 50 && vol > 0) return "BUY";
  // Sell signal
  if (lastFast < lastSlow && rsi < 50 && vol > 0) return "SELL";

  return null;
}

// ===== Trading Logic =====
async function placeTrade(signal, price, volume) {
  const timestamp = new Date();

  if (signal === "BUY" && !inPosition) {
    inPosition = true;
    currentTrade = {
      side: "BUY",
      entryPrice: price,
      entryTime: timestamp,
      volume,
    };
    await ordersCol.insertOne({ ...currentTrade, status: "OPEN" });
    console.log(`🟢 BUY @ ${price}`);
  }

  if (signal === "SELL" && inPosition && currentTrade?.side === "BUY") {
    inPosition = false;
    const pnl = price - currentTrade.entryPrice;
    equity += pnl;
    const closed = {
      ...currentTrade,
      exitPrice: price,
      exitTime: timestamp,
      pnl,
      status: "CLOSED",
    };
    await ordersCol.updateOne(
      { _id: currentTrade._id },
      { $set: closed },
      { upsert: true }
    );
    currentTrade = null;
    console.log(`🔴 SELL @ ${price} | PnL = ${pnl.toFixed(2)}`);
  }

  await saveState();
}

// ===== Binance WS =====
const ws = new WebSocket(
  `wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@kline_${TIMEFRAME_MINUTES}`
);

ws.on("message", async (msg) => {
  const data = JSON.parse(msg);
  const k = data.k;
  if (!k.x) return; // only closed candles

  const close = parseFloat(k.c);
  const volume = parseFloat(k.v);

  updateIndicators(close, volume);

  const signal = generateSignal();
  if (signal) {
    await placeTrade(signal, close, volume);
  }
});

// ===== APIs =====
app.get("/status", async (req, res) => {
  res.json({ inPosition, equity, currentTrade });
});

app.get("/trades", async (req, res) => {
  const trades = await ordersCol.find().toArray();
  res.json(trades);
});

app.get("/pnl", async (req, res) => {
  const trades = await ordersCol.find({ status: "CLOSED" }).toArray();
  const totalPnL = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  res.json({
    totalPnL,
    totalTrades: trades.length,
    winRate:
      trades.length > 0
        ? (
            (trades.filter((t) => t.pnl > 0).length / trades.length) *
            100
          ).toFixed(2) + "%"
        : "0%",
  });
});

app.get("/pnl/daily", async (req, res) => {
  const trades = await ordersCol.find({ status: "CLOSED" }).toArray();
  const daily = {};
  trades.forEach((t) => {
    const day = new Date(t.exitTime).toISOString().split("T")[0];
    daily[day] = (daily[day] || 0) + (t.pnl || 0);
  });
  res.json(daily);
});

app.delete("/trades", async (req, res) => {
  await ordersCol.deleteMany({});
  res.json({ message: "All trades cleared" });
});

app.delete("/state", async (req, res) => {
  await stateCol.deleteOne({ _id: "bot" });
  inPosition = false;
  equity = 1000;
  currentTrade = null;
  res.json({ message: "Bot state reset" });
});

// ===== Start Server =====

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API server running on port ${PORT}`)
);
