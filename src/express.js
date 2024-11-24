const express = require('express')
const app = express()
const port = 8000

const statsTemplate = `Statistics
==========
Total users: <2>
Total unique mentions: <3>

Endpoints
=========
/ - This page
/data/graph.gexf - GEXF graph data

powered by graphology, express.js, prisma, and discord.js
`

function expressMain(prisma) {
    app.get('/', async (req, res) => {
        const totalUsers = await prisma.userLookup.count();
        const totalUniqueMentions = await prisma.mention.count();
        res.set('Content-Type', 'text/plain');
        res.send(statsTemplate.replace('<2>', totalUsers).replace('<3>', totalUniqueMentions));
    });

    app.listen(port, () => {
        console.log(`Express server listening at http://localhost:${port}!`);
    });
}

module.exports = { expressMain }