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

// ── NEW: saves table ──
db.run(`
CREATE TABLE IF NOT EXISTS saves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    song_json TEXT NOT NULL,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, song_json)
)
`);

/* ===============================
   CORE ARTISTS
=============================== */

const coreArtists = [
    "Kritin Kay", "Adarsh Rao", "Garvit", "Osho Jain", "Samar Mehdi", 
    "Samad Khan", "King", "Accha Insaan", "Abhay Jodhpurkar", 
    "Abhijeet Srivastava", "Adithya Bhardwaj", "Mitraz", "Zaeden", 
    "Saahel", "Dikshant", "The Yellow Diary", "Aditya Rikhari", 
    "Pratsofficial", "Anuv Jain", "Prateek Kuhad", "When Chai Met Toast",
    "The Local Train", "Naalayak", "Bayaan", "Hari & Sukhmani",
    "Shubh", "AP Dhillon", "Tarsem Jassar", "Gurinder Gill", 
    "Karan Aujla", "Diljit Dosanjh", "Lisa Mishra", "Shalmali Kholgade",
    "Nilotpal Bora", "Ritviz", "Nucleya", "Dualist Inquiry", 
    "Madboy/Mink", "Saba Azad", "Parekh & Singh", "F16s", 
    "Peter Cat Recording Co.", "Dhruv Visvanath", "Shantanu Pandit",
    "Raghav Meattle", "Sanjeeta Bhattacharya", "Kamakshi Khanna"
];

/* ===============================
   DELAY HELPER
=============================== */

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* ===============================
   GET EXPANDED ARTISTS
=============================== */

async function getExpandedArtists(accessToken, artistName) {
    const artistList = [];

    try {
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
                    limit: 2,
                    market: "IN"
                }
            }
        );

        if (searchSimilar.data.artists.items) {
            searchSimilar.data.artists.items.forEach(a => {
                if (!artistList.find(existing => existing.id === a.id)) {
                    artistList.push(a);
                }
            });
        }
    } catch (error) {
        console.log(`Error getting expanded artists for ${artistName}:`, error.message);
    }

    return artistList;
}

/* ===============================
   IMPORT ARTISTS (DISCOVERY ENGINE)
=============================== */

async function importArtists() {
    try {
        const accessToken = await getSpotifyAccessToken();
        let totalNewSongs = 0;

        for (const artistName of coreArtists) {

            console.log("Importing:", artistName);

            const expandedArtists = await getExpandedArtists(accessToken, artistName);

            for (const artist of expandedArtists) {
                
                try {
                    const albumsRes = await axios.get(
                        `https://api.spotify.com/v1/artists/${artist.id}/albums`,
                        {
                            headers: { Authorization: `Bearer ${accessToken}` },
                            params: { include_groups: "single,album", limit: 5, market: "IN" }
                        }
                    );

                    for (const album of albumsRes.data.items) {

                        const releaseDate = new Date(album.release_date);
                        const now = new Date();
                        const diffDays = (now - releaseDate) / (1000 * 60 * 60 * 24);
                        const isFresh = diffDays <= 60;

                        try {
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
                                        if (!err && this.changes > 0) {
                                            totalNewSongs++;
                                            console.log(`  ✅ Added: ${track.name} - ${artist.name}`);
                                        }
                                    }
                                );
                            }
                        } catch (error) {
                            console.log(`  Error fetching tracks for ${album.name}:`, error.message);
                        }

                        await delay(1000);
                    }
                } catch (error) {
                    console.log(`  Error fetching albums for ${artist.name}:`, error.message);
                }

                await delay(1500);
            }

            await delay(2000);
        }

        console.log(`\n🎉 Artist discovery sync complete! Added ${totalNewSongs} new songs ✅`);
        
        db.get("SELECT COUNT(*) as total FROM songs", (err, row) => {
            console.log(`📊 Total songs in database: ${row.total}`);
        });

    } catch (error) {
        console.error("Import error:", error.response?.data || error.message);
    }
}

/* ===============================
   ROUTES
=============================== */

// Trigger artist import
app.get("/import-artists", async (req, res) => {
    res.json({ status: "Artist discovery sync started ✅" });
    await importArtists();
});

// Get all songs
app.get("/songs", (req, res) => {
    const type = req.query.type;
    const limit = parseInt(req.query.limit) || 1000;

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

// Get real album cover for a song
app.get("/api/cover/:id", async (req, res) => {
    const songId = req.params.id;
    
    db.get("SELECT title, artist, cover_url FROM songs WHERE id = ?", [songId], async (err, song) => {
        if (err || !song) {
            return res.json({ cover: null });
        }
        
        if (song.cover_url && song.cover_url.includes('i.scdn.co') && song.cover_url.length > 50) {
            return res.json({ cover: song.cover_url });
        }
        
        try {
            const token = await getSpotifyAccessToken();
            const searchRes = await axios.get("https://api.spotify.com/v1/search", {
                headers: { Authorization: `Bearer ${token}` },
                params: { q: `${song.title} ${song.artist}`, type: "track", limit: 1, market: "IN" }
            });
            
            const track = searchRes.data.tracks.items[0];
            if (track && track.album.images[0]) {
                const coverUrl = track.album.images[0].url;
                db.run("UPDATE songs SET cover_url = ? WHERE id = ?", [coverUrl, songId]);
                res.json({ cover: coverUrl });
            } else {
                res.json({ cover: null });
            }
        } catch (error) {
            console.log("Cover fetch error:", error.message);
            res.json({ cover: null });
        }
    });
});

// Get Spotify track ID for a song (for embed player)
app.get("/api/trackid/:id", async (req, res) => {
    const songId = req.params.id;
    
    db.get("SELECT title, artist, spotify_id FROM songs WHERE id = ?", [songId], async (err, song) => {
        if (err || !song) {
            return res.json({ trackId: null });
        }
        
        if (song.spotify_id) {
            return res.json({ trackId: song.spotify_id });
        }
        
        try {
            const token = await getSpotifyAccessToken();
            const searchRes = await axios.get("https://api.spotify.com/v1/search", {
                headers: { Authorization: `Bearer ${token}` },
                params: { q: `${song.title} ${song.artist}`, type: "track", limit: 1, market: "IN" }
            });
            
            const track = searchRes.data.tracks.items[0];
            if (track) {
                db.run("UPDATE songs SET spotify_id = ? WHERE id = ?", [track.id, songId]);
                res.json({ trackId: track.id });
            } else {
                res.json({ trackId: null });
            }
        } catch (error) {
            console.log("Track ID fetch error:", error.message);
            res.json({ trackId: null });
        }
    });
});

// Health check with song count
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
   NEW: SAVES API (PERSISTENT STORAGE)
=============================== */

// GET all saved songs for a user
app.get("/api/saves", (req, res) => {
    const uid = req.header("X-Indiefy-UID");
    if (!uid) {
        return res.status(400).json({ error: "Missing X-Indiefy-UID header" });
    }
    db.all(
        "SELECT song_json FROM saves WHERE user_id = ? ORDER BY saved_at ASC",
        [uid],
        (err, rows) => {
            if (err) {
                console.error("GET /api/saves error:", err.message);
                return res.status(500).json({ error: "Database error" });
            }
            try {
                const songs = rows.map(r => JSON.parse(r.song_json));
                res.json(songs);
            } catch (e) {
                res.status(500).json({ error: "Parse error" });
            }
        }
    );
});

// POST — save a song
app.post("/api/saves", (req, res) => {
    const uid = req.header("X-Indiefy-UID");
    if (!uid) return res.status(400).json({ error: "Missing X-Indiefy-UID header" });

    const song = req.body;
    if (!song || !song.title) {
        return res.status(400).json({ error: "Invalid song body" });
    }

    const songJson = JSON.stringify(song);

    db.run(
        "INSERT OR IGNORE INTO saves (user_id, song_json) VALUES (?, ?)",
        [uid, songJson],
        function (err) {
            if (err) {
                console.error("POST /api/saves error:", err.message);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ ok: true, id: this.lastID });
        }
    );
});

// DELETE — unsave a song
app.delete("/api/saves", (req, res) => {
    const uid = req.header("X-Indiefy-UID");
    if (!uid) return res.status(400).json({ error: "Missing X-Indiefy-UID header" });

    const song = req.body;
    if (!song || !song.title) {
        return res.status(400).json({ error: "Invalid song body" });
    }

    const songJson = JSON.stringify(song);

    db.run(
        "DELETE FROM saves WHERE user_id = ? AND song_json = ?",
        [uid, songJson],
        function (err) {
            if (err) {
                console.error("DELETE /api/saves error:", err.message);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ ok: true, deleted: this.changes });
        }
    );
});

/* ===============================
   WEEKLY AUTO SYNC (FRIDAY 6PM)
=============================== */
/* ===============================
   PREVIEW PROXY (iTunes → backend → frontend)
=============================== */

/* ===============================
   PREVIEW PROXY (Deezer)
=============================== */

app.get("/api/preview", async (req, res) => {
    const { title, artist } = req.query;
    if (!title) return res.json({ preview: null });

    try {
        const q = encodeURIComponent(`${title} ${artist || ""}`);
        const r = await axios.get(
            `https://api.deezer.com/search?q=${q}&limit=5`,
            { headers: { "User-Agent": "Indiefy/1.0" } }
        );
        const match = (r.data.data || []).find(x => x.preview);
        res.json({ preview: match ? match.preview : null });
    } catch (e) {
        console.error("Preview proxy error:", e.message);
        res.json({ preview: null });
    }
});
cron.schedule("0 18 * * 5", () => {
    console.log("Running weekly artist discovery sync...");
    importArtists();
});

/* ===============================
   START SERVER
=============================== */

app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
});