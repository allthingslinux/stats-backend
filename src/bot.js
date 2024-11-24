// Import required modules
const { Client, Events, GatewayIntentBits } = require('discord.js');
const { PrismaClient } = require('@prisma/client');
const Graph = require('graphology');
const gexf = require('graphology-gexf');
const fs = require('fs');
const crypto = require('crypto');
const { expressMain } = require('./express');

// Initialize Prisma Client
const prisma = new PrismaClient();

// Utility: Encrypt user ID
function anonymousId(id) {
    const encryptionKey = process.env.ENCRYPTION_KEY;
    // encryption key is 32 base64 characters
    // needs to return the same thing every time
    const iv = Buffer.alloc(16, 0); // Initialization vector.
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(encryptionKey, 'base64'), iv);
    let encrypted = cipher.update(id.toString());
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return encrypted.toString('base64');
}

// Utility: Update user in the database or create if not exists
async function updateUserLookup(prisma, user) {
    if (!user) return;
    await prisma.userLookup.upsert({
        where: { id: BigInt(user.id) },
        update: { username: user.username },
        create: { id: BigInt(user.id), username: user.username },
    });
}

// Counter for mentions processed
let mentionsCounter = 0; // Reset counter
const MENTIONS_THRESHOLD = 15; // Generate graph every 15 mentions

// Generate the GEXF graph
async function generateGEXF() {
    await console.log('Generating graph...');

    // Create a new graph
    const graph = new Graph();

    // Fetch all mentions and user lookups
    const mentions = await prisma.mention.findMany();
    const userLookups = await prisma.userLookup.findMany();

    // Create a map for anonymized user data
    const anonymizedLookups = new Map();
    userLookups.forEach((user) => {
        const hashedId = anonymousId(user.id);
        anonymizedLookups.set(user.id, {
            id: hashedId,
            username: user.anonymous ? 'Anonymous User' : user.username,
            fullOptOut: user.fullOptOut,
        });
    });

    // Add nodes to the graph
    anonymizedLookups.forEach((user, originalId) => {
        if (!user.fullOptOut) {
            graph.addNode(user.id, { label: user.username });
        }
    });

    // Add edges to the graph
    mentions.forEach((mention) => {
        const user1 = anonymizedLookups.get(mention.user1Id);
        const user2 = anonymizedLookups.get(mention.user2Id);

        if (user1 && user2 && !user1.fullOptOut && !user2.fullOptOut) {
            if (graph.hasEdge(user1.id, user2.id)) {
                graph.updateEdgeAttribute(user1.id, user2.id, 'weight', (w) => w + mention.count);
            } else {
                graph.addEdge(user1.id, user2.id, { weight: mention.count });
            }
        }
    });

    // Export the graph
    try {
        fs.writeFileSync('data/graph.gexf', gexf.write(graph));
        console.log('Graph successfully exported to data/graph.gexf');
    } catch (err) {
        console.error('Error exporting graph:', err);
    }
}

// Create the Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// On client ready
client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    readyClient.user.setActivity(process.env.ACTIVITY);
    expressMain(prisma);
});

// Handle commands
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith(process.env.PREFIX)) {
        const args = message.content.slice(process.env.PREFIX.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        switch (command) {
            case 'help':
                message.channel.send(`
**stats!**
Commands:
- **help**: Show this message
- **ping**: Check bot latency
- **toggleanonymous**: Toggle anonymous mode for yourself in the graph
                `);
                break;

            case 'ping':
                message.channel.send(`Pong! Latency is ${Date.now() - message.createdTimestamp}ms.`);
                break;

            case 'toggleanonymous':
                const user = await prisma.userLookup.findUnique({
                    where: { id: BigInt(message.author.id) },
                });

                if (user) {
                    const updated = await prisma.userLookup.update({
                        where: { id: BigInt(message.author.id) },
                        data: { anonymous: !user.anonymous },
                    });
                    message.channel.send(`Anonymous mode set to ${updated.anonymous}`);
                } else {
                    await prisma.userLookup.create({
                        data: {
                            id: BigInt(message.author.id),
                            username: message.author.username,
                            anonymous: false,
                        },
                    });
                    message.channel.send(`Anonymous mode set to false`);
                }
                break;

            case 'optout':


            default:
                message.channel.send(`Unknown command. Type **${process.env.PREFIX}help** for help.`);
        }
    }
});

// Handle mentions for graph updates
client.on(Events.MessageCreate, async (message) => {
    if (message.guild?.id !== process.env.DISCORD_SERVER_ID || message.channel?.id !== process.env.DISCORD_CHANNEL_ID) {
        return;
    }

    if (message.mentions.users.size === 0) return;

    await updateUserLookup(prisma, message.author);

    for (const user of message.mentions.users.values()) {
        await updateUserLookup(prisma, user);

        const [user1Id, user2Id] = [BigInt(message.author.id), BigInt(user.id)].sort((a, b) => (a < b ? -1 : 1));

        await prisma.mention.upsert({
            where: { user1Id_user2Id: { user1Id, user2Id } },
            update: { count: { increment: 1 } },
            create: { user1Id, user2Id, count: 1 },
        });
    }

    // Increment counter and generate graph if threshold is met
    mentionsCounter++;
    console.log(`Mentions processed: ${mentionsCounter}`);

    if (mentionsCounter >= MENTIONS_THRESHOLD) {
        mentionsCounter = 0; // Reset counter
        await generateGEXF();
    }
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
