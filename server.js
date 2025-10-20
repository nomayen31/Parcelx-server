// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.8k7klrr.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

async function run() {
    try {
        await client.connect();
        console.log(" Connected to MongoDB successfully!");

        const db = client.db(process.env.DB_NAME);
        const parcelsCollection = db.collection("parcels");

        app.get("/parcels", async (req, res) => {
            const parcels = await parcelsCollection.find().toArray();
            res.send(parcels);
        });


        app.post("/parcels", async (req, res) => {
            const newParcel = req.body;
            console.log(" Received new parcel:", newParcel);

            try {
                const result = await parcelsCollection.insertOne(newParcel);
                res.status(201).send({
                    success: true,
                    message: "Parcel added successfully!",
                    data: result,
                });
            } catch (error) {
                console.error("Error inserting parcel:", error);
                res.status(500).send({
                    success: false,
                    message: "Failed to add parcel.",
                    error: error.message,
                });
            }
        });
        // 🟢 GET: Fetch all parcels or user-specific parcels (sorted by latest)
        app.get("/parcels", async (req, res) => {
            try {
                const email = req.query.email;
                const query = email ? { createdByEmail: email } : {};

                // Fetch parcels, newest first
                const parcels = await parcelsCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json({
                    success: true,
                    total: parcels.length,
                    data: parcels,
                });
            } catch (error) {
                console.error("❌ Error fetching parcels:", error);
                res.status(500).json({
                    success: false,
                    message: "Failed to fetch parcels.",
                    error: error.message,
                });
            }
        });

        app.get("/", (req, res) => {
            res.send(" ParcelX Server with MongoDB is Running...");
        });

        app.listen(port, () => {
            console.log(`🚀 Server running on http://localhost:${port}`);
        });
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
    }
}

run().catch(console.dir);
