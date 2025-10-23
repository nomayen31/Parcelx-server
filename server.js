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
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking"); // ✅ Added tracking collection

    // Helpful indexes (safe to run repeatedly)
    await paymentsCollection.createIndex({ createdAt: -1 });
    await paymentsCollection.createIndex({ payerEmail: 1, createdAt: -1 });
    await paymentsCollection.createIndex(
      { paymentIntentId: 1 },
      { unique: true }
    );

    // Tracking indexes for fast lookups
    await trackingCollection.createIndex({ tracking_id: 1, time: -1 });
    await trackingCollection.createIndex({ parcel_id: 1 });

    // ======= ROUTES =======

    /** -----------------------------------------------------
     * Parcels CRUD
     * ----------------------------------------------------*/
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;
        const query = email ? { createdByEmail: email } : {};
        const parcels = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();
        res
          .status(200)
          .json({ success: true, total: parcels.length, data: parcels });
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Failed to fetch parcels.",
            error: error.message,
          });
      }
    });

    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = {
          ...req.body,
          paymentStatus: req.body.paymentStatus || "Unpaid",
          createdAtReadable:
            req.body.createdAtReadable || new Date().toISOString(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await parcelsCollection.insertOne(newParcel);
        res
          .status(201)
          .json({
            success: true,
            message: "Parcel added successfully!",
            data: result,
          });
      } catch (error) {
        console.error("Error inserting parcel:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Failed to add parcel.",
            error: error.message,
          });
      }
    });

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id))
          return res
            .status(400)
            .json({ success: false, message: "Invalid ID format" });

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });
        if (result.deletedCount > 0)
          res.json({
            success: true,
            message: "Parcel deleted!",
            deletedCount: result.deletedCount,
          });
        else
          res
            .status(404)
            .json({ success: false, message: "Parcel not found!" });
      } catch (error) {
        console.error("❌ Delete error:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id))
          return res
            .status(400)
            .json({ success: false, message: "Invalid ID format" });

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel)
          return res
            .status(404)
            .json({ success: false, message: "Parcel not found" });
        res.status(200).json({ success: true, data: parcel });
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    /** -----------------------------------------------------
     * Stripe Payment API
     * ----------------------------------------------------*/
    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amountInCents, parcelId, payerEmail } = req.body;
        const amountMinor = Number(amountInCents);
        if (!Number.isInteger(amountMinor) || amountMinor <= 0)
          return res.status(400).json({ error: "Invalid amountInCents value" });

        console.log(
          `💰 Creating PaymentIntent for amount: ${amountMinor}, parcelId: ${parcelId}`
        );
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountMinor,
          currency: "usd",
          automatic_payment_methods: { enabled: true },
          metadata: { parcelId: parcelId || "", payerEmail: payerEmail || "" },
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (error) {
        console.error("Stripe error:", error);
        res.status(400).json({ error: error.message });
      }
    });

    app.post("/payments/confirm", async (req, res) => {
      try {
        const {
          parcelId,
          paymentIntentId,
          amountInCents,
          currency = "usd",
          payer = {},
        } = req.body;

        if (!parcelId || !paymentIntentId)
          return res
            .status(400)
            .json({
              success: false,
              message: "parcelId and paymentIntentId are required",
            });

        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (!pi || pi.status !== "succeeded")
          return res
            .status(400)
            .json({ success: false, message: "PaymentIntent not succeeded" });

        const orFilter = [];
        if (ObjectId.isValid(parcelId))
          orFilter.push({ _id: new ObjectId(parcelId) });
        orFilter.push({ _id: parcelId });
        const parcelFilter =
          orFilter.length > 1 ? { $or: orFilter } : orFilter[0];

        const upd = await parcelsCollection.updateOne(parcelFilter, {
          $set: { paymentStatus: "Paid", updatedAt: new Date() },
        });

        const setOnInsertDoc = {
          paymentIntentId: pi.id,
          parcelId: ObjectId.isValid(parcelId)
            ? new ObjectId(parcelId)
            : parcelId,
          payerName: payer.name || null,
          payerEmail: payer.email || pi.metadata?.payerEmail || null,
          createdAt: new Date(),
        };

        const setDoc = {
          status: pi.status,
          amount: pi.amount,
          currency: pi.currency,
        };

        await paymentsCollection.updateOne(
          { paymentIntentId: pi.id },
          { $setOnInsert: setOnInsertDoc, $set: setDoc },
          { upsert: true }
        );

        const updatedParcel = await parcelsCollection.findOne(parcelFilter);
        res.status(200).json({
          success: true,
          message: "Payment recorded and parcel marked Paid",
          data: updatedParcel,
        });
      } catch (err) {
        console.error("payments/confirm error:", err);
        res.status(500).json({ success: false, message: err.message });
      }
    });

    app.get("/payments", async (req, res) => {
      try {
        const { email, page = 1, limit = 20 } = req.query;
        const q = email ? { payerEmail: email } : {};
        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

        const cursor = paymentsCollection
          .find(q)
          .sort({ createdAt: -1 })
          .skip((pageNum - 1) * lim)
          .limit(lim);
        const [items, total] = await Promise.all([
          cursor.toArray(),
          paymentsCollection.countDocuments(q),
        ]);

        res
          .status(200)
          .json({
            success: true,
            total,
            page: pageNum,
            limit: lim,
            data: items,
          });
      } catch (error) {
        console.error("Error fetching payments:", error);
        res
          .status(500)
          .json({
            success: false,
            message: "Failed to fetch payments",
            error: error.message,
          });
      }
    });

    /** -----------------------------------------------------
     * Tracking API (✅ Now works)
     * ----------------------------------------------------*/
    app.post("/tracking", async (req, res) => {
      try {
        const {
          tracking_id,
          parcel_id,
          status,
          message,
          updated_by = "",
        } = req.body;

        if (!tracking_id && !parcel_id) {
          return res
            .status(400)
            .json({
              success: false,
              message: "tracking_id or parcel_id is required",
            });
        }

        const log = {
          tracking_id,
          parcel_id: parcel_id ? new ObjectId(parcel_id) : null,
          status,
          message,
          time: new Date(),
          updated_by,
        };

        const result = await trackingCollection.insertOne(log);
        res.status(201).json({
          success: true,
          message: "Tracking log added successfully",
          data: result.insertedId,
        });
      } catch (error) {
        console.error("Error adding tracking log:", error);
        res.status(500).json({
          success: false,
          message: "Failed to add tracking log",
          error: error.message,
        });
      }
    });

    // ✅ Get all tracking updates for a given tracking_id
    app.get("/tracking/:trackingId", async (req, res) => {
      try {
        const { trackingId } = req.params;
        const logs = await trackingCollection
          .find({ tracking_id: trackingId })
          .sort({ time: -1 })
          .toArray();
        res.status(200).json({ success: true, total: logs.length, data: logs });
      } catch (error) {
        console.error("Error fetching tracking logs:", error);
        res.status(500).json({ success: false, message: error.message });
      }
    });
    app.post("/users", (req, res) => {
      // Logic to save the user to the database
      console.log(req.body);
      res.status(201).send({ message: "User created in DB" });
    });

    // Root route
    app.get("/", (req, res) => {
      res.send("🚀 ParcelX Server with MongoDB and Stripe is Running...");
    });

    // Start server
    app.listen(port, () =>
      console.log(`🌍 Server running at http://localhost:${port}`)
    );
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);
