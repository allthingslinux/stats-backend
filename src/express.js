const express = require('express')
const { Client } = require('discord.js');
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
GET > text/plain

/data/graph.gexf - GEXF graph data
GET > text/plain

/api/roles - provide select role data
POST json (user_id: int) > json (user_id: int, roles: [int])

powered by graphology, express.js, prisma, and discord.js
`

function expressMain(prisma, client) {
    app.get('/', async (req, res) => {
        const totalUsers = await prisma.userLookup.count();
        const totalUniqueMentions = await prisma.mention.count();
        const totalNonAnonymousUsers = await prisma.userLookup.count({ where: { anonymous: false } });
        const totalAnonymousUsers = await prisma.userLookup.count({ where: { anonymous: true } });
        const totalOptOutUsers = await prisma.userLookup.count({ where: { fullOptOut: true } });
        res.set('Content-Type', 'text/plain');
        res.send(statsTemplate.replace('<2>', totalUsers).replace('<3>', totalUniqueMentions).replace('<4>', totalNonAnonymousUsers).replace('<5>', totalAnonymousUsers).replace('<6>', totalOptOutUsers));
    });

    app.use(express.json()); // Ensure this middleware is added

    app.post('/api/roles', async (req, res) => {
        const userId = req.body?.user_id; // Safely access user_id
        if (!userId) {
            res.status(400).send({ error: 'Missing user_id in request body' });
            return;
        }

        try {
            // Fetch user roles from database
            const userRoles = await prisma.userLookup.findUnique({
                where: { id: BigInt(userId) },
                select: { roles: true } // Only fetch roles
            });

            if (!userRoles) {
                res.status(404).send({ error: 'User not found' });
                return;
            }

            // Filter roles based on allowed roles
            const allowedRoles = process.env.ALLOWED_ROLES.split(',');
            const filteredRoles = userRoles.roles.filter((role) =>
                allowedRoles.includes(role)
            );

            res.status(200).send({ user_id: userId, roles: filteredRoles });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: 'Internal server error' });
        }
    });


    app.listen(port, () => {
        console.log(`Express server listening at http://localhost:${port}!`);
    });
}

module.exports = { expressMain }