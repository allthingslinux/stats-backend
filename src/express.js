const express = require('express');
const { Client } = require('discord.js');
const app = express()
const port = 8000

const statsTemplate = `Statistics
==========
Total users: <2>
Total unique mentions: <3>

Endpoints
=========
/ - This page
GET > text/plain

/privacy - Privacy policy
GET > text/html

/data/graph.gexf - GEXF graph data
GET > text/plain

A accuratelinuxgraphs.com project. Bringing accuracy to the world one accuracy at a time.
Sponsored by ARG Solutions (Alpine Regional Group): Coming 2036. Containerized development is the future and we are bringing this to everyone.
`

function expressMain(prisma, client) {
    app.get('/', async (req, res) => {
        const totalUsers = await prisma.userLookup.count();
        const totalUniqueMentions = await prisma.mention.count();
        res.set('Content-Type', 'text/plain');
        res.send(statsTemplate.replace('<2>', totalUsers).replace('<3>', totalUniqueMentions));
    });

    app.get('/privacy', async (req, res) => {
        res.set('Content-Type', 'text/html');
        res.sendFile('privacypolicy.html', { root: __dirname });
    });

    app.use(express.json()); // Ensure this middleware is added

    app.listen(port, () => {
        console.log(`Express server listening at http://localhost:${port}!`);
    });
}

module.exports = { expressMain }
