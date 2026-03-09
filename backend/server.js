require("dotenv").config();

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

/* ===============================
   SPOTIFY CONFIG
=============================== */

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

/* ===============================
   GET ACCESS TOKEN
=============================== */

async function getSpotifyAccessToken() {
    const response = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
            grant_type: "client_credentials",
        }),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Authorization:
                    "Basic " +
                    Buffer.from(clientId + ":" + clientSecret).toString("base64"),
            },
        }
    );

    return response.data.access_token;
}

/* ===============================
   DATABASE
=============================== */

const db = new sqlite3.Database("./songs.db", (err) => {
    if (err) console.error(err.message);
    else console.log("Connected to SQLite database ✅");
});

db.run(`
CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    artist TEXT,
    year TEXT,
    album TEXT,
    cover_url TEXT,
    spotify_url TEXT,
    spotify_id TEXT UNIQUE,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);

/* ===============================
   CORE ARTISTS
=============================== */

const coreArtists = [
    "Kritin Kay",
    "Adarsh Rao",
    "Garvit",
    "Osho Jain",
    "Samar Mehdi",
    "Samad Khan",
    "King",
    "Accha Insaan",
    "Abhay Jodhpurkar",
    "Abhijeet Srivastava",
    "Adithya Bhardwaj",
    "Mitraz",
    "Zaeden",
    "Saahel",
    "Dikshant",
    "The Yellow Diary",
    "Aditya Rikhari",
    "Pratsofficial"
];

/* ===============================
   EXPAND ARTISTS (SAFE SEARCH)
=============================== */

async function getExpandedArtists(accessToken, artistName) {
    const artistList = [];

    const searchMain = await axios.get(
        "https://api.spotify.com/v1/search",
        {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: { q: artistName, type: "artist", limit: 1, market: "IN" }
        }
    );

    const mainArtist = searchMain.data.artists.items[0];
    if (!mainArtist) return artistList;

    artistList.push(mainArtist);

    const searchSimilar = await axios.get(
        "https://api.spotify.com/v1/search",
        {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
                q: artistName + " hindi indie",
                type: "artist",
                limit: 3,
                market: "IN"
            }
        }
    );

    searchSimilar.data.artists.items.forEach(a => {
        if (!artistList.find(existing => existing.id === a.id)) {
            artistList.push(a);
        }
    });

    return artistList;
}

/* ===============================
   DELAY HELPER
=============================== */

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ===============================
   IMPORT ARTISTS (DISCOVERY ENGINE)
=============================== */

async function importArtists() {
    try {
        const accessToken = await getSpotifyAccessToken();

        for (const artistName of coreArtists) {

            console.log("Importing:", artistName);

            const expandedArtists = await getExpandedArtists(accessToken, artistName);

            for (const artist of expandedArtists) {

                const albumsRes = await axios.get(
                    `https://api.spotify.com/v1/artists/${artist.id}/albums`,
                    {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        params: { include_groups: "single", limit: 3, market: "IN" }
                    }
                );

                for (const album of albumsRes.data.items) {

                    const releaseDate = new Date(album.release_date);
                    const now = new Date();
                    const diffDays = (now - releaseDate) / (1000 * 60 * 60 * 24);
                    const isFresh = diffDays <= 60;

                    const tracksRes = await axios.get(
                        `https://api.spotify.com/v1/albums/${album.id}/tracks`,
                        {
                            headers: { Authorization: `Bearer ${accessToken}` }
                        }
                    );

                    for (const track of tracksRes.data.items) {

                        const lowerTitle = track.name.toLowerCase();

                        if (
                            lowerTitle.includes("live") ||
                            lowerTitle.includes("remix") ||
                            lowerTitle.includes("instrumental") ||
                            lowerTitle.includes("acoustic")
                        ) continue;

                        db.run(
                            `INSERT OR IGNORE INTO songs 
                            (title, artist, year, album, cover_url, spotify_url, spotify_id, source) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                            [
                                track.name,
                                artist.name,
                                album.release_date?.split("-")[0] || "",
                                album.name,
                                album.images[0]?.url || "",
                                track.external_urls.spotify,
                                track.id,
                                isFresh ? "fresh" : "artist"
                            ],
                            function (err) {
                                if (err) console.error("Insert error:", err.message);
                            }
                        );
                    }

                    await delay(300); // delay after each album
                }

                await delay(400); // delay after each artist
            }

            await delay(500); // delay after each core artist
        }

        console.log("Artist discovery sync complete ✅");

    } catch (error) {
        console.error("Import error:", error.response?.data || error.message);
    }
}

/* ===============================
   ROUTES
=============================== */

//app.get("/import-artists", async (req, res) => {
 //   await importArtists();
  //  res.json({ status: "Artist discovery synced ✅" });
//});

app.get("/songs", (req, res) => {
    const type = req.query.type;
    const limit = parseInt(req.query.limit) || 100;

    let query = "SELECT * FROM songs";
    let params = [];

    if (type === "fresh") {
        query += " WHERE source = ?";
        params.push("fresh");
    }

    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error("Fetch error:", err.message);
            return res.status(500).json({ error: "Database error" });
        }

        res.json(rows);
    });
});

app.get("/health", (req, res) => {
    db.get("SELECT COUNT(*) as total FROM songs", (err, row) => {
        if (err) {
            return res.status(500).json({
                status: "error",
                database: "not connected"
            });
        }

        res.json({
            status: "ok",
            database: "connected",
            totalSongs: row.total
        });
    });
});

/* ===============================
   WEEKLY AUTO SYNC (FRIDAY 6PM)
=============================== */

//cron.schedule("0 18 * * 5", () => {
  //  console.log("Running weekly artist discovery sync...");
   // importArtists();
//});//

/* =============================== */
app.get("/songs", (req, res) => {
    res.json([
        {
            title: "Alag Aasmaan",
            artist: "Anuv Jain",
            album: "Alag Aasmaan",
            year: "2020",
            cover_url: "https://i.scdn.co/image/ab67616d0000b2731",
            spotify_url: "https://open.spotify.com/"
        },
        {
            title: "Gul",
            artist: "Anuv Jain",
            album: "Gul",
            year: "2021",
            cover_url: "https://i.scdn.co/image/ab67616d0000b2732",
            spotify_url: "https://open.spotify.com/"
        }
    ]);
});
app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
});