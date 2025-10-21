import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import Stripe from "stripe";

dotenv.config();
const stripe = new Stripe(process.env.PAYMENT_GATEWAY_KEY);
const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ---------- MongoDB Setup ----------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8k7klrr.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// ---------- Main Run Function ----------
async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB successfully");

    const db = client.db(process.env.DB_NAME);
    const parcelsCollection = db.collection("parcels");

    // ======= ROUTES =======

    // Get all parcels (with optional email filter)
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { createdByEmail: email } : {};
        const parcels = await parcelsCollection.find(query).sort({ createdAt: -1 }).toArray();

        res.status(200).json({
          success: true,
          total: parcels.length,
          data: parcels,
        });
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({ success: false, message: "Failed to fetch parcels.", error: error.message });
      }
    });

    // Add new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).json({ success: true, message: "Parcel added successfully!", data: result });
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res.status(500).json({ success: false, message: "Failed to add parcel.", error: error.message });
      }
    });

    // Delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid ID format" });
        }

        const result = await parcelsCollection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount > 0) {
          res.json({ success: true, message: "Parcel deleted!" });
        } else {
          res.status(404).json({ success: false, message: "Parcel not found!" });
        }
      } catch (error) {
        console.error("❌ Delete error:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // Get single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ success: false, message: "Invalid ID format" });
        }

        const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });
        if (!parcel) {
          return res.status(404).json({ success: false, message: "Parcel not found" });
        }

        res.status(200).json({ success: true, data: parcel });
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    // ---------- Stripe PaymentIntent ----------
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCents } = req.body;
        const amountMinor = Number(amountInCents);

        if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
          return res.status(400).json({ error: "Invalid amountInCents value" });
        }

        console.log(`💰 Creating PaymentIntent for amount: ${amountMinor} USD (cents)`);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountMinor, // smallest unit
          currency: "usd", // change to 'bdt' if your account supports it
          automatic_payment_methods: { enabled: true },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(400).json({ error: error.message });
      }
    });

    // Root route
    app.get("/", (req, res) => {
      res.send("🚀 ParcelX Server with MongoDB and Stripe is Running...");
    });

    // Start server
    app.listen(port, () => console.log(`🌍 Server running at http://localhost:${port}`));
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);
