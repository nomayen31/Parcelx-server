// server.js (or server/index.js)
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
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

// ---------- Main Run Function ----------
async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB successfully");

    const db = client.db(process.env.DB_NAME);
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");

    // Helpful indexes (safe to run repeatedly)
    await paymentsCollection.createIndex({ createdAt: -1 });
    await paymentsCollection.createIndex({ payerEmail: 1, createdAt: -1 });
    await paymentsCollection.createIndex({ paymentIntentId: 1 }, { unique: true });

    // ======= ROUTES =======

    // Get all parcels (optional email filter)
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { createdByEmail: email } : {};
        const parcels = await parcelsCollection.find(query).sort({ createdAt: -1 }).toArray();

        res.status(200).json({ success: true, total: parcels.length, data: parcels });
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({ success: false, message: "Failed to fetch parcels.", error: error.message });
      }
    });

    // Add new parcel (with sensible defaults)
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = {
          ...req.body,
          paymentStatus: req.body.paymentStatus || "Unpaid",
          createdAtReadable: req.body.createdAtReadable || new Date().toISOString(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
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
          res.json({ success: true, message: "Parcel deleted!", deletedCount: result.deletedCount });
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
        const { amountInCents, parcelId, payerEmail } = req.body;
        const amountMinor = Number(amountInCents);

        if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
          return res.status(400).json({ error: "Invalid amountInCents value" });
        }

        console.log(`💰 Creating PaymentIntent for amount: ${amountMinor} (minor units), parcelId: ${parcelId}`);

        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountMinor, // smallest unit
          currency: "usd", // switch to 'bdt' if your Stripe account supports it
          automatic_payment_methods: { enabled: true },
          metadata: {
            parcelId: parcelId || "",
            payerEmail: payerEmail || "",
          },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(400).json({ error: error.message });
      }
    });

    /**
     * Confirm/finalize a payment from client.
     * - Verifies PaymentIntent with Stripe
     * - Marks parcel as Paid
     * - Upserts a payments row (idempotent by paymentIntentId)
     * Supports both ObjectId and string _id (in case older docs used string ids).
     */
    app.post("/payments/confirm", async (req, res) => {
      try {
        const {
          parcelId,
          paymentIntentId,
          amountInCents, // optional sanity check
          currency = "usd",
          payer = {}, // { name, email, country, postal_code }
        } = req.body;

        if (!parcelId) {
          return res.status(400).json({ success: false, message: "parcelId is required" });
        }
        if (!paymentIntentId) {
          return res.status(400).json({ success: false, message: "paymentIntentId is required" });
        }

        // 1) Verify PaymentIntent with Stripe
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (!pi || pi.status !== "succeeded") {
          return res.status(400).json({ success: false, message: "PaymentIntent not succeeded" });
        }

        // Optional sanity checks
        if (amountInCents && Number(amountInCents) !== Number(pi.amount)) {
          return res.status(400).json({ success: false, message: "Amount mismatch" });
        }
        if (currency && currency.toLowerCase() !== pi.currency) {
          return res.status(400).json({ success: false, message: "Currency mismatch" });
        }

        // 2) Support both ObjectId and string _id
        const orFilter = [];
        if (ObjectId.isValid(parcelId)) orFilter.push({ _id: new ObjectId(parcelId) });
        orFilter.push({ _id: parcelId }); // if docs were inserted with string _id
        const parcelFilter = orFilter.length > 1 ? { $or: orFilter } : orFilter[0];

        console.log("[payments/confirm] parcelId:", parcelId, "filter:", parcelFilter);

        // 3) Mark parcel as Paid
        const upd = await parcelsCollection.updateOne(parcelFilter, {
          $set: { paymentStatus: "Paid", updatedAt: new Date() },
        });

        console.log("[payments/confirm] update matchedCount:", upd.matchedCount, "modifiedCount:", upd.modifiedCount);

        if (upd.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: `Parcel not found for id ${parcelId} (check if _id is string vs ObjectId)`,
          });
        }

        // 4) Upsert payment record (NO key overlap between $setOnInsert and $set)
        const setOnInsertDoc = {
          paymentIntentId: pi.id,
          parcelId: ObjectId.isValid(parcelId) ? new ObjectId(parcelId) : parcelId,
          payerName: payer.name || null,
          payerEmail: payer.email || pi.metadata?.payerEmail || null,
          country: payer.country || null,
          postalCode: payer.postal_code || null,
          createdAt: new Date(), // for DESC sort
        };

        const setDoc = {
          status: pi.status,   // mutable fields only here
          amount: pi.amount,
          currency: pi.currency,
        };

        const upsertRes = await paymentsCollection.updateOne(
          { paymentIntentId: pi.id },
          { $setOnInsert: setOnInsertDoc, $set: setDoc },
          { upsert: true }
        );

        console.log("[payments/confirm] payments upsert =>", {
          matched: upsertRes.matchedCount,
          modified: upsertRes.modifiedCount,
          upsertedId: upsertRes.upsertedId,
        });

        // 5) Return updated parcel
        const updatedParcel =
          (ObjectId.isValid(parcelId)
            ? await parcelsCollection.findOne({ _id: new ObjectId(parcelId) })
            : await parcelsCollection.findOne({ _id: parcelId })) || null;

        return res.status(200).json({
          success: true,
          message: "Payment recorded and parcel marked Paid",
          data: updatedParcel,
        });
      } catch (err) {
        console.error("payments/confirm error:", err);
        return res.status(500).json({ success: false, message: err.message });
      }
    });

    // List payment history (user or all), descending with pagination
    // GET /payments?email=user@x.com&page=1&limit=20
    app.get("/payments", async (req, res) => {
      try {
        const { email, page = 1, limit = 20 } = req.query;

        const q = {};
        if (email) q.payerEmail = email;

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        const cursor = paymentsCollection.find(q).sort({ createdAt: -1 }).skip((pageNum - 1) * lim).limit(lim);

        const [items, total] = await Promise.all([cursor.toArray(), paymentsCollection.countDocuments(q)]);

        res.status(200).json({ success: true, total, page: pageNum, limit: lim, data: items });
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).json({ success: false, message: "Failed to fetch payments", error: error.message });
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
