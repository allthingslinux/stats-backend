const { Client, Events, GatewayIntentBits } = require('discord.js');
const { PrismaClient } = require('@prisma/client');
const Graph = require('graphology');
const gexf = require('graphology-gexf');
const fs = require('fs');
const crypto = require('crypto');
const { expressMain } = require('./express');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const influx = new InfluxDB({ url: process.env.INFLUXDB_URL, token: process.env.INFLUXDB_TOKEN });
const writeApi = influx.getWriteApi(process.env.INFLUXDB_ORG, process.env.INFLUXDB_BUCKET);

// Initialize Prisma Client
const prisma = new PrismaClient();

// Global counters
let mentionsCounter = 0;
const MENTIONS_THRESHOLD = 15;
let totalMessagesProcessed = 0; // Count every non-bot message processed
let commandCount = 0;           // Count every command processed
let graphGenerationCounter = 0; // Count how many times the graph is generated

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

// Global listener to count all non-bot messages
client.on(Events.MessageCreate, async (message) => {
    if (!message.author.bot) {
        totalMessagesProcessed++;
    }
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
    console.log(`[UserLookup] Updated data for user ${user.username}`);
}

// Log global metrics to InfluxDB with additional stats
async function logMetrics() {
    try {
        const optedInCount = await prisma.userLookup.count();
        
        // Aggregate mention data: sum, min, and max of counts
        const mentionAggregate = await prisma.mention.aggregate({
            _sum: { count: true },
            _min: { count: true },
            _max: { count: true },
        });
        const totalMentions = mentionAggregate._sum.count || 0;
        const minMentions = mentionAggregate._min.count || 0;
        const maxMentions = mentionAggregate._max.count || 0;
        
        // Unique mention combinations (each record is a unique pair)
        const uniqueMentionCombinations = await prisma.mention.count();
        const avgMentionsPerPair = uniqueMentionCombinations > 0 ? totalMentions / uniqueMentionCombinations : 0;
        const avgMentionsPerUser = optedInCount > 0 ? totalMentions / optedInCount : 0;
        
        const guild = client.guilds.cache.get(process.env.DISCORD_SERVER_ID);
        const totalUsers = guild ? guild.memberCount : 0;
        const mentionDensity = totalUsers > 0 ? totalMentions / totalUsers : 0;
        
        console.log(`[Metrics] Opted in users: ${optedInCount}`);
        console.log(`[Metrics] Total users in guild: ${totalUsers}`);
        console.log(`[Metrics] Total mentions count: ${totalMentions}`);
        console.log(`[Metrics] Unique mention combinations: ${uniqueMentionCombinations}`);
        console.log(`[Metrics] Avg mentions per pair: ${avgMentionsPerPair}`);
        console.log(`[Metrics] Min mentions in any pair: ${minMentions}`);
        console.log(`[Metrics] Max mentions in any pair: ${maxMentions}`);
        console.log(`[Metrics] Avg mentions per opted-in user: ${avgMentionsPerUser}`);
        console.log(`[Metrics] Mention density (mentions/guild user): ${mentionDensity}`);
        console.log(`[Metrics] Total messages processed: ${totalMessagesProcessed}`);
        console.log(`[Metrics] Total commands processed: ${commandCount}`);
        console.log(`[Metrics] Graph generation count: ${graphGenerationCounter}`);

        const point = new Point('discord_metrics')
            .tag('server', process.env.DISCORD_SERVER_ID)
            .intField('opted_in_users', optedInCount)
            .intField('guild_total_users', totalUsers)
            .intField('total_mentions', totalMentions)
            .intField('unique_mention_combinations', uniqueMentionCombinations)
            .floatField('avg_mentions_per_pair', avgMentionsPerPair)
            .intField('min_mentions', minMentions)
            .intField('max_mentions', maxMentions)
            .floatField('avg_mentions_per_user', avgMentionsPerUser)
            .floatField('mention_density', mentionDensity)
            .intField('total_messages_processed', totalMessagesProcessed)
            .intField('command_count', commandCount)
            .intField('graph_generation_count', graphGenerationCounter)
            .timestamp(new Date());
        writeApi.writePoint(point);
        await writeApi.flush();
        console.log('[Metrics] Global metrics logged to InfluxDB successfully.');
    } catch (error) {
        console.error('[Metrics] Error logging global metrics:', error);
    }
}

// Log user-specific metrics: total mentions, distinct partners, and average mentions per partner
async function logUserMetrics() {
    try {
        const users = await prisma.userLookup.findMany();
        for (const user of users) {
            // Total mentions where the user is involved (sum of counts)
            const userMentionAggregate = await prisma.mention.aggregate({
                _sum: { count: true },
                where: {
                    OR: [
                        { user1Id: BigInt(user.id) },
                        { user2Id: BigInt(user.id) }
                    ]
                }
            });
            const userTotalMentions = userMentionAggregate._sum.count || 0;
            // Count of distinct mention records (i.e. distinct partners)
            const userDistinctPartners = await prisma.mention.count({
                where: {
                    OR: [
                        { user1Id: BigInt(user.id) },
                        { user2Id: BigInt(user.id) }
                    ]
                }
            });
            const userAvgMentionsPerPartner = userDistinctPartners > 0 ? userTotalMentions / userDistinctPartners : 0;
            
            console.log(`[UserMetrics] ${user.username}: total_mentions = ${userTotalMentions}, distinct_partners = ${userDistinctPartners}, avg_mentions_per_partner = ${userAvgMentionsPerPartner}`);
            
            const point = new Point('discord_user_metrics')
                .tag('user_id', user.id.toString())
                .tag('username', user.username)
                .intField('user_total_mentions', userTotalMentions)
                .intField('user_distinct_partners', userDistinctPartners)
                .floatField('user_avg_mentions_per_partner', userAvgMentionsPerPartner)
                .timestamp(new Date());
            writeApi.writePoint(point);
        }
        await writeApi.flush();
        console.log('[UserMetrics] User-specific metrics logged to InfluxDB successfully.');
    } catch (error) {
        console.error('[UserMetrics] Error logging user-specific metrics:', error);
    }
}

// Generate the GEXF graph and increment graph generation counter
async function generateGEXF() {
    console.log('Generating graph...');
    graphGenerationCounter++; // Increment the graph generation counter

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
    // Log both global and user-specific metrics
    await logMetrics();
    await logUserMetrics();
}

// On client ready
client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    readyClient.user.setActivity(process.env.ACTIVITY);
    expressMain(prisma);
    logMetrics();     // Log global metrics on startup
    logUserMetrics(); // Log user-specific metrics on startup
});

// Handle commands and increment command count
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith(process.env.PREFIX)) {
        commandCount++; // Increment command counter
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
                console.log('[Command] Help command executed.');
                break;

            case 'optin':
                if (await prisma.userLookup.findUnique({ where: { id: BigInt(message.author.id) } })) {
                    message.channel.send("You are already opted in!");
                    console.log(`[OptIn] User ${message.author.username} attempted to opt in but is already opted in.`);
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
                console.log(`[OptIn] User ${message.author.username} opted in.`);
                await generateGEXF();
                break;

            case 'optout':
                if (!await prisma.userLookup.findUnique({ where: { id: BigInt(message.author.id) } })) {
                    message.channel.send("You are already opted out!");
                    console.log(`[OptOut] User ${message.author.username} attempted to opt out but was already opted out.`);
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
                console.log(`[OptOut] User ${message.author.username} opted out.`);
                await generateGEXF();
                break;

            case 'forcetoggleoptin':
                // check if user id is bot owner
                if (message.author.id !== process.env.BOT_OWNER) {
                    message.channel.send("You are not authorized to use this command.");
                    console.log('[ForceToggle] Unauthorized access attempt.');
                    return;
                }

                if (message.mentions.users.size === 0) {
                    message.channel.send("You must mention a user to toggle their opt-in status.");
                    return;
                }
                
                const toggledUser = message.mentions.users.first();
                // Only allow toggling if the mentioned user is a bot
                if (!toggledUser.bot) {
                    message.channel.send("You can only force toggle bot statuses to prevent abuse.");
                    console.log(`[ForceToggle] Attempted to toggle non-bot user ${toggledUser.username}.`);
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
                    console.log(`[ForceToggle] Force opt-out for ${toggledUser.username} completed.`);
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
                    console.log(`[ForceToggle] Force opt-in for ${toggledUser.username} completed.`);
                }

                await generateGEXF();
                break;

            case 'forceoptout':
                // check if user id is bot owner
                if (message.author.id !== process.env.BOT_OWNER) {
                    message.channel.send("You are not authorized to use this command.");
                    console.log('[ForceOptOut] Unauthorized access attempt.');
                    return;
                }

                if (message.mentions.users.size === 0) {
                    message.channel.send("You must mention a user to force opt-out.");
                    return;
                }

                const forceOptOutUser = message.mentions.users.first();

                await prisma.userLookup.delete({
                    where: { id: BigInt(forceOptOutUser.id) }
                }).catch(e => console.error("User not opted in:", e));

                await prisma.mention.deleteMany({
                    where: {
                        OR: [
                            { user1Id: BigInt(forceOptOutUser.id) },
                            { user2Id: BigInt(forceOptOutUser.id) }
                        ]
                    }
                });
                message.channel.send(`Force opt-out for ${forceOptOutUser.username} completed.`);
                console.log(`[ForceOptOut] Force opt-out for ${forceOptOutUser.username} completed.`);
                await generateGEXF();
                break;

            case 'ping':
                const latency = Date.now() - message.createdTimestamp;
                message.channel.send(`Pong! Latency is ${latency}ms.`);
                console.log(`[Ping] Responded with latency ${latency}ms.`);
                break;

            default:
                message.channel.send(`Unknown command. Type **${process.env.PREFIX}help** for help.`);
                console.log(`[Command] Unknown command received: ${command}`);
        }
    }
});

// Handle mentions for graph updates (only for opted-in users)
client.on(Events.MessageCreate, async (message) => {
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
        console.log(`[Mentions] Processed mention from ${message.author.username} to ${user.username}`);
    }

    mentionsCounter++;
    console.log(`Mentions processed counter: ${mentionsCounter}`);
    if (mentionsCounter >= MENTIONS_THRESHOLD) {
        mentionsCounter = 0;
        await generateGEXF();
    }
    
    // Log metrics on each mention update
    await logMetrics();
    await logUserMetrics();
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
    console.log(`[GuildRemove] Removed data for user ${member.user.username}`);
    await generateGEXF();
});

// Start the bot
client.login(process.env.DISCORD_TOKEN);
