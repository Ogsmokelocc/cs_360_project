//importing express api
import express from 'express';
import type { Request, Response } from 'express';

//Import sql connection tool this can be changed if we want to use mysql
import { Pool } from 'pg'; //can change this for mySQL or whatever

//this will allow the frontend (html stuff) to commicate with the backend stuff
import cors from 'cors';

//creating express application instance
const app = express();
const PORT = 3000;

//this is the middleware which will allow requests from the browser 
app.use(cors());
app.use(express.json());




// Fetch markets from Polymarket Gamma API
app.get("/markets", async (req, res) => {
    try {
        const response = await fetch("https://gamma-api.polymarket.com/markets");
        const data = await response.json();

        // just send first few markets (cleaner)
        res.json(data.slice(0, 5));
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch markets" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});