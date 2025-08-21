import { MongoClient, ServerApiVersion } from "mongodb";
import axios from "axios";
import cron from "node-cron";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

// ====== MongoDB Setup ======
const uri =
  process.env.MONGO_URI ||
  "mongodb+srv://ArvindETH:Arvind2001@tracktohack.2rudkmv.mongodb.net/?retryWrites=true&w=majority&appName=TrackToHack";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db, ordersCollection, pnlCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("tradingBot"); // database name
    ordersCollection = db.collection("orders");
    pnlCollection = db.collection("pnl");

    console.log("✅ Connected to MongoDB Atlas!");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}
await connectDB();

// ====== Global Vars ======
let latestPrice = null;
let currentBuy = null;
// ====== Replace Binance with CoinGecko ======
async function fetchPrice() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price",
      {
        params: {
          ids: "ethereum",   // coin id
          vs_currencies: "usd",
        },
      }
    );

    latestPrice = res.data.ethereum.usd;
    return latestPrice
  } catch (err) {
    console.error("❌ Price fetch failed:", err.message);
  }
}

// ====== Buy Order ======
async function placeBuyOrder() {
  try {
    // Always fetch latest price before order
    const price = await fetchPrice();
    if (!price) return console.log("⏳ Waiting for price feed...");

    const buyOrder = {
      type: "buy",
      price,
      qty: 1,
      time: new Date(),
    };

    await ordersCollection.insertOne(buyOrder);
    currentBuy = buyOrder;

    console.log(
      `🟢 BUY: 1 ETH at $${price} [${new Date().toLocaleTimeString()}]`
    );

    // Schedule sell after 2 min
    setTimeout(placeSellOrder, 120 * 1000);
  } catch (err) {
    console.error("❌ Buy order failed:", err.message);
  }
}

// ====== Sell Order ======
async function placeSellOrder() {
  try {
    if (!currentBuy) return console.log("⚠️ No active buy to sell.");

    // Always fetch latest price before selling
    const price = await fetchPrice();
    if (!price) return console.log("⏳ Waiting for price feed...");

    const sellOrder = {
      type: "sell",
      price,
      qty: 1,
      time: new Date(),
    };

    await ordersCollection.insertOne(sellOrder);

    // Calculate PNL
    const pnlValue = (sellOrder.price - currentBuy.price) * currentBuy.qty;

    const pnlEntry = {
      buyPrice: currentBuy.price,
      sellPrice: sellOrder.price,
      profitLoss: pnlValue,
      time: new Date(),
    };

    await pnlCollection.insertOne(pnlEntry);

    // Console log with color
    if (pnlValue >= 0) {
      console.log(
        `✅ SELL: 1 ETH at $${sellOrder.price} | PNL: \x1b[32m+$${pnlValue.toFixed(
          2
        )}\x1b[0m`
      );
    } else {
      console.log(
        `✅ SELL: 1 ETH at $${sellOrder.price} | PNL: \x1b[31m$${pnlValue.toFixed(
          2
        )}\x1b[0m`
      );
    }

    currentBuy = null;
  } catch (err) {
    console.error("❌ Sell order failed:", err.message);
  }
}


// ====== CRON JOB (every 5 min) ======
cron.schedule("* * * * *", () => {
  console.log("\n==============================");
  console.log(`🚀 New Cycle Started [${new Date().toLocaleTimeString()}]`);
  placeBuyOrder();
});

// ====== Express API ======
const app = express();
const PORT = process.env.PORT || 4000;

// Get total PNL
app.get("/api/pnl/total", async (req, res) => {
  try {
    const result = await pnlCollection
      .aggregate([{ $group: { _id: null, totalPnL: { $sum: "$profitLoss" } } }])
      .toArray();

    const total = result.length > 0 ? result[0].totalPnL : 0;
    res.json({ totalPnL: total.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all PNL history
app.get("/api/pnl/history", async (req, res) => {
  try {
    const history = await pnlCollection.find().sort({ time: -1 }).toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ API server running on port ${PORT}`)
);
