const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const dbPath = path.resolve("./songs.db");
console.log("DB PATH:", dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Database error:", err.message);
  } else {
    console.log("Connected to SQLite database ✅");
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      artist TEXT,
      year TEXT
    )
  `);
});

module.exports = db;
