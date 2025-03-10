const { Client, Events, GatewayIntentBits } = require('discord.js');
const { PrismaClient } = require('@prisma/client');
const Graph = require('graphology');
const gexf = require('graphology-gexf');
const fs = require('fs');
const crypto = require('crypto');
const { expressMain } = require('./express');

// Initialize Prisma Client
const prisma = new PrismaClient();

// Create the Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ],
});

// Utility: Update user info only if the user is opted in (exists in UserLookup)
async function updateUserLookup(prisma, user) {
    if (!user) return;
    // Check if user is opted in
    const existing = await prisma.userLookup.findUnique({
        where: { id: BigInt(user.id) }
    });
    if (!existing) return; // user is not opted in, do nothing

    const member = await user.client.guilds.cache
        .get(process.env.DISCORD_SERVER_ID)
        ?.members.fetch(user.id);
    const avatar = member ? member.user.displayAvatarURL() : "https://cdn.discordapp.com/embed/avatars/0.png";
    const displayname = member ? member.displayName : user.username;
    await prisma.userLookup.update({
        where: { id: BigInt(user.id) },
        data: { username: user.username, displayname, avatar },
    });
}

// Counter for mentions processed
let mentionsCounter = 0;
const MENTIONS_THRESHOLD = 15;

// Generate the GEXF graph
async function generateGEXF() {
    console.log('Generating graph...');

    // Create a new graph
    const graph = new Graph();

    // Fetch all mentions and user lookups
    const mentions = await prisma.mention.findMany();
    const userLookups = await prisma.userLookup.findMany();

    // Create a map of users (keyed by their id as string)
    const userMap = new Map();
    userLookups.forEach((user) => {
        const key = user.id.toString();
        userMap.set(key, {
            id: user.id,
            username: user.username,
            displayname: user.displayname,
            avatar: user.avatar,
        });
    });

    // Add nodes for each opted-in user in the graph
    userMap.forEach((user) => {
        graph.addNode(user.id, { label: user.displayname, subLabel: user.username, type: 'image', image: user.avatar });
    });

    // Add edges for each mention
    mentions.forEach((mention) => {
        const key1 = mention.user1Id.toString();
        const key2 = mention.user2Id.toString();
        const user1 = userMap.get(key1);
        const user2 = userMap.get(key2);
        if (user1 && user2) {
            if (graph.hasEdge(user1.id, user2.id)) {
                graph.updateEdgeAttribute(user1.id, user2.id, 'weight', (w) => w + mention.count);
            } else {
                graph.addEdge(user1.id, user2.id, { weight: mention.count });
            }
        }
    });

    // Export the graph to a GEXF file
    try {
        fs.writeFileSync('data/graph.gexf', gexf.write(graph));
        console.log('Graph successfully exported to data/graph.gexf');
    } catch (err) {
        console.error('Error exporting graph:', err);
    }
}

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
- **optin**: Opt in to the graph (you are opted out by default)
- **optout**: Opt out of the graph (all your data will be removed)

When you opt out all your data will be removed from the graph.
You automatically opt out when you leave the server. Your data will also be removed when you leave.

You can view the graph at https://stats.atl.dev/
Privacy policy: https://stats-backend.atl.dev/privacy
                `);
                break;

            case 'optin':
                if (await prisma.userLookup.findUnique({ where: { id: BigInt(message.author.id) } })) {
                    message.channel.send("You are already opted in!");
                    return;
                }
                // Add the user to the database
                const member = await message.client.guilds.cache
                    .get(process.env.DISCORD_SERVER_ID)
                    ?.members.fetch(message.author.id);
                const avatar = member ? member.user.displayAvatarURL() : "https://cdn.discordapp.com/embed/avatars/0.png";
                const displayname = member ? member.displayName : message.author.username;
                await prisma.userLookup.upsert({
                    where: { id: BigInt(message.author.id) },
                    update: { username: message.author.username, displayname, avatar },
                    create: { id: BigInt(message.author.id), username: message.author.username, displayname, avatar },
                });
                message.channel.send("You have successfully opted in to the graph!");
                await generateGEXF();
                break;

            case 'optout':
                if (!await prisma.userLookup.findUnique({ where: { id: BigInt(message.author.id) } })) {
                    message.channel.send("You are already opted out!");
                    return;
                }
                // Delete the user from the database
                await prisma.userLookup.delete({
                    where: { id: BigInt(message.author.id) }
                }).catch(e => console.error("User not opted in:", e));

                // Delete any mention data involving the user
                await prisma.mention.deleteMany({
                    where: {
                        OR: [
                            { user1Id: BigInt(message.author.id) },
                            { user2Id: BigInt(message.author.id) }
                        ]
                    }
                });
                message.channel.send("You have successfully opted out, and your data has been removed from the graph.");
                await generateGEXF();
                break;

            case 'forcetoggleoptin':
                // check if user id is bot owner
                if (message.author.id !== process.env.BOT_OWNER) {
                    message.channel.send("You are not authorized to use this command.");
                    return;
                }

                // check if user they are trying to toggle is not a bot, if so do not allow
                // to prevent force toggling legitimate users
                if (message.mentions.users.size === 0) {
                    message.channel.send("You must mention a user to toggle their opt-in status.");
                    return;
                }
                
                const toggledUser = message.mentions.users.first();
                // Only allow toggling if the mentioned user is a bot
                if (!toggledUser.bot) {
                    message.channel.send("You can only force toggle bot statuses to prevent abuse.");
                    return;
                }

                const toggledUserRecord = await prisma.userLookup.findUnique({
                    where: { id: BigInt(toggledUser.id) }
                });

                if (toggledUserRecord) {
                    await prisma.userLookup.delete({ where: { id: BigInt(toggledUser.id) } });
                    await prisma.mention.deleteMany({
                        where: {
                            OR: [
                                { user1Id: BigInt(toggledUser.id) },
                                { user2Id: BigInt(toggledUser.id) }
                            ]
                        }
                    });
                    message.channel.send(`Force opt-out for ${toggledUser.username} completed.`);
                } else {
                    const member = await message.client.guilds.cache
                        .get(process.env.DISCORD_SERVER_ID)
                        ?.members.fetch(toggledUser.id);
                    const avatar = member ? member.user.displayAvatarURL() : "https://cdn.discordapp.com/embed/avatars/0.png";
                    const displayname = member ? member.displayName : toggledUser.username;
                    await prisma.userLookup.upsert({
                        where: { id: BigInt(toggledUser.id) },
                        update: { username: toggledUser.username, displayname, avatar },
                        create: { id: BigInt(toggledUser.id), username: toggledUser.username, displayname, avatar },
                    });
                    message.channel.send(`Force opt-in for ${toggledUser.username} completed.`);
                }

                await generateGEXF();
                break;

            case 'forceoptout':
                // check if user id is bot owner
                if (message.author.id !== process.env.BOT_OWNER) {
                    message.channel.send("You are not authorized to use this command.");
                    return;
                }

                // check if user they are trying to toggle is not a bot, if so do not allow
                // to prevent force toggling legitimate users
                if (message.mentions.users.size === 0) {
                    message.channel.send("You must mention a user to force opt-out.");
                    return;
                }

                // Delete the user from the database
                await prisma.userLookup.delete({
                    where: { id: BigInt(forceOptOutUser.id) }
                }).catch(e => console.error("User not opted in:", e));

                // Delete any mention data involving the user
                await prisma.mention.deleteMany({
                    where: {
                        OR: [
                            { user1Id: BigInt(forceOptOutUser.id) },
                            { user2Id: BigInt(forceOptOutUser.id) }
                        ]
                    }
                });
                message.channel.send(`Force opt-out for ${forceOptOutUser.username} completed.`);
                await generateGEXF();
                break;
            case 'ping':
                message.channel.send(`Pong! Latency is ${Date.now() - message.createdTimestamp}ms.`);
                break;

            default:
                message.channel.send(`Unknown command. Type **${process.env.PREFIX}help** for help.`);
        }
    }
});

// Handle mentions for graph updates (only for opted-in users)
client.on(Events.MessageCreate, async (message) => {
    // Process only if the message is from the specified server and channel
    if (message.guild?.id !== process.env.DISCORD_SERVER_ID || message.channel?.id !== process.env.DISCORD_CHANNEL_ID) {
        console.log('Ignoring message from different server or channel');
        return;
    }

    if (message.mentions.users.size === 0) return;

    // Check if the message author is opted in
    const authorRecord = await prisma.userLookup.findUnique({
        where: { id: BigInt(message.author.id) }
    });
    if (!authorRecord) {
        console.log(`Author ${message.author.username} is not opted in, skipping mention processing.`);
        return;
    }
    await updateUserLookup(prisma, message.author);

    // Process each mentioned user only if they are opted in
    for (const user of message.mentions.users.values()) {
        const mentionedRecord = await prisma.userLookup.findUnique({
            where: { id: BigInt(user.id) }
        });
        if (!mentionedRecord) {
            console.log(`Mentioned user ${user.username} is not opted in, skipping.`);
            continue;
        }
        await updateUserLookup(prisma, user);

        // Sort user IDs so that user1Id < user2Id
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
        mentionsCounter = 0;
        await generateGEXF();
    }
});

// On server leave, remove the user's data
client.on(Events.GuildMemberRemove, async (member) => {
    console.log(`User ${member.user.username} left the server. Removing their data...`);
    await prisma.userLookup.delete({
        where: { id: BigInt(member.id) }
    }).catch(e => console.error(e));
    await prisma.mention.deleteMany({
        where: {
            OR: [
                { user1Id: BigInt(member.id) },
                { user2Id: BigInt(member.id) }
            ]
        }
    });
    await generateGEXF();
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
