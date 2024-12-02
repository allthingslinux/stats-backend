const express = require('express')
const app = express()
const port = 8000

const statsTemplate = `Statistics
==========
Total users: <2>
Total unique mentions: <3>
Total non-anonymous users: <4>
Total anonymous users: <5>
Total users who left and got opted out: <6>

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
        const totalNonAnonymousUsers = await prisma.userLookup.count({ where: { anonymous: false } });
        const totalAnonymousUsers = await prisma.userLookup.count({ where: { anonymous: true } });
        const totalOptOutUsers = await prisma.userLookup.count({ where: { fullOptOut: true } });
        res.set('Content-Type', 'text/plain');
        res.send(statsTemplate.replace('<2>', totalUsers).replace('<3>', totalUniqueMentions).replace('<4>', totalNonAnonymousUsers).replace('<5>', totalAnonymousUsers).replace('<6>', totalOptOutUsers));
    });

    app.listen(port, () => {
        console.log(`Express server listening at http://localhost:${port}!`);
    });
}

module.exports = { expressMain }