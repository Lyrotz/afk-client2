const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const app = express();

app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const bots = {}; 
const attackIntervals = {};
const attackConfigs = {}; 
const survivalIntervals = {}; 
const reconnectTimeouts = {}; 
const potionIntervals = {}; 
const clients = []; 

function sendLog(msg) {
    const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(logEntry); 
    clients.forEach(client => client.write(`data: ${logEntry}\n\n`)); 
}

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    clients.push(res);
    req.on('close', () => clients.splice(clients.indexOf(res), 1));
});

app.get('/api/bots', (req, res) => {
    const active = Object.values(bots).map(b => b.originalName);
    const pending = Object.keys(reconnectTimeouts).map(id => id.toUpperCase());
    const allKnownBots = [...new Set([...active, ...pending])];
    res.send(allKnownBots);
});

async function drinkOminousPotion(bot) {
    const potion = bot.inventory.items().find(i => i.name === 'ominous_bottle' || i.name.includes('potion'));
    
    if (!potion) {
        sendLog(`${bot.originalName} lacks the ominous potion.`);
        return;
    }

    try {
        await bot.equip(potion, 'hand');
        await bot.consume();
        sendLog(`${bot.originalName} drank the ominous potion.`);
    } catch (err) {
        sendLog(`[ERR] ${bot.originalName} failed to drink: ${err.message}`);
    }
}

function initBot(username, password) {
    const botId = username.toLowerCase();
    
    if (reconnectTimeouts[botId]) {
        clearTimeout(reconnectTimeouts[botId]);
        delete reconnectTimeouts[botId];
    }

    if (bots[botId]) return null;

    sendLog(`Starting bot: ${username}`);
    const bot = mineflayer.createBot({
        host: 'play.tulparmc.com',
        port: 25565,
        username: username,
        version: '1.19.4'
    });

    bot.originalName = username;
    bot.loginPassword = password; 

    bot.once('spawn', () => {
        sendLog(`${username} spawned. Executing login...`);
        setTimeout(() => {
            bot.chat(`/login ${password}`);
            setTimeout(() => {
                bot.chat('/survival');
                sendLog(`${username} executed /survival.`);
                
                survivalIntervals[botId] = setInterval(() => {
                    if (bots[botId]) {
                        bots[botId].chat('/survival');
                        sendLog(`${username} auto-executed /survival (10m loop).`);
                    }
                }, 600000);
                
                if (attackConfigs[botId] && attackConfigs[botId].active) {
                    sendLog(`Resuming attack loop for ${username}...`);
                    delete attackIntervals[botId]; 
                    manageAttackInterval(botId, attackConfigs[botId].delay, 'start');
                }
            }, 3000);
        }, 1000);
    });

    bot.on('chat', (usernameSender, message) => {
        if (usernameSender === bot.username) return; 
        sendLog(`[CHAT] <${usernameSender}> ${message}`);
    });

    bot.on('whisper', (usernameSender, message) => {
        sendLog(`[WHISPER] from <${usernameSender}>: ${message}`);
    });

    bot.on('kicked', reason => {
        sendLog(`${username} kicked: ${reason}`);
        handleConnectionLoss(username, password, botId);
    });
    
    bot.on('error', err => {
        sendLog(`${username} error: ${err.message}`);
        handleConnectionLoss(username, password, botId);
    });
    
    bot.on('end', () => {
        sendLog(`${username} disconnected.`);
        cleanupBotState(botId);
    });

    bots[botId] = bot;
    return bot;
}

function cleanupBotState(botId) {
    delete bots[botId];
    
    if (attackIntervals[botId]) {
        clearInterval(attackIntervals[botId]);
        delete attackIntervals[botId];
    }
    if (survivalIntervals[botId]) {
        clearInterval(survivalIntervals[botId]);
        delete survivalIntervals[botId];
    }
    if (potionIntervals[botId]) {
        clearInterval(potionIntervals[botId]);
        delete potionIntervals[botId];
    }
}

function handleConnectionLoss(username, password, botId) {
    cleanupBotState(botId);
    sendLog(`${username} connection lost. Reconnecting in 30s...`);
    
    reconnectTimeouts[botId] = setTimeout(() => {
        delete reconnectTimeouts[botId]; 
        if (!bots[botId]) initBot(username, password);
    }, 30000); 
}

function manageAttackInterval(botId, delaySeconds, action) {
    const bot = bots[botId];
    if (!bot) return { status: 'error', message: 'Bot offline.' };
    const username = bot.originalName;

    if (action === 'start') {
        if (attackIntervals[botId]) return { status: 'error', message: 'Already attacking.' };
        attackConfigs[botId] = { active: true, delay: delaySeconds };
        
        sendLog(`Starting zero-rotation attack loop for ${username}`);

        const intervalId = setInterval(() => {
            const activeBot = bots[botId];
            if (activeBot && activeBot.entity) {
                activeBot.setControlState('sprint', false);
                activeBot.setControlState('jump', false);

                const target = activeBot.nearestEntity(entity => {
                    return entity.name === 'armor_stand' &&
                           entity.position.distanceTo(activeBot.entity.position) < 4;
                });

                if (target) {
                    activeBot.attack(target); 
                } else {
                    activeBot.swingArm('right');
                }
            } else {
                clearInterval(intervalId);
                delete attackIntervals[botId];
            }
        }, delaySeconds * 1000);
        
        attackIntervals[botId] = intervalId;
        return { status: 'success', message: 'Attack started.' };
    } 
    
    if (action === 'stop') {
        if (!attackIntervals[botId]) return { status: 'error', message: 'Not attacking.' };
        if (attackConfigs[botId]) attackConfigs[botId].active = false;
        
        clearInterval(attackIntervals[botId]);
        delete attackIntervals[botId];
        sendLog(`Stopped attack loop for ${username}.`);
        return { status: 'success', message: 'Attack stopped.' };
    }
    return { status: 'error', message: 'Invalid action.' };
}

app.post('/api/bots/add', (req, res) => {
    const { username, password } = req.body;
    if (initBot(username, password)) {
        res.send({ status: 'success', message: `${username} initiated.` });
    } else {
        res.status(400).send({ status: 'error', message: `Bot active.` });
    }
});

app.post('/api/bots/batch-add', async (req, res) => {
    const { accounts } = req.body;
    if (!accounts || !Array.isArray(accounts)) {
        return res.status(400).send({ status: 'error', message: 'Invalid payload.' });
    }

    res.send({ status: 'success', message: `BATCH_SEQ_STARTED (${accounts.length})` });
    sendLog(`[SYS] Initiating batch login for ${accounts.length} units. Delay: 5s per unit.`);

    for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        if (acc.username && acc.password) {
            initBot(acc.username, acc.password);
            
            if (i < accounts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
    sendLog(`[SYS] Batch login sequence finished.`);
});

app.post('/api/bots/disconnect', (req, res) => {
    const botId = req.body.username.toLowerCase();
    let actionTaken = false;

    if (reconnectTimeouts[botId]) {
        clearTimeout(reconnectTimeouts[botId]);
        delete reconnectTimeouts[botId];
        sendLog(`[SYS] Cancelled pending reconnection for ${botId}`);
        actionTaken = true;
    }

    if (attackConfigs[botId]) {
        attackConfigs[botId].active = false;
    }

    if (bots[botId]) {
        bots[botId].quit();
        actionTaken = true;
    }

    if (actionTaken) {
        res.send({ status: 'success', message: `KILLED_PROCESS: ${botId}` });
    } else {
        res.status(404).send({ status: 'error', message: 'NO_PROCESS_FOUND' });
    }
});

app.post('/api/bots/chat', (req, res) => {
    const target = req.body.target.toLowerCase();
    const { message } = req.body;
    
    if (target === 'all') {
        Object.values(bots).forEach(b => b.chat(message));
        sendLog(`[OUTGOING BROADCAST]: ${message}`);
    } else if (bots[target]) {
        bots[target].chat(message);
        sendLog(`[OUTGOING] ${bots[target].originalName}: ${message}`);
    } else {
        return res.status(404).send({ status: 'error', message: 'Target offline.' });
    }
    res.send({ status: 'success', message: 'Message sent.' });
});

app.post('/api/bots/hotbar', (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });

    const slotInt = parseInt(req.body.slot);
    if (isNaN(slotInt) || slotInt < 0 || slotInt > 8) return res.status(400).send({ error: 'Invalid slot' });

    bot.setQuickBarSlot(slotInt);
    sendLog(`${bot.originalName} changed hotbar to ${slotInt}`);
    res.send({ status: 'success', message: `Slot set` });
});

app.get('/api/bots/:username/inventory', (req, res) => {
    const botId = req.params.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline' });
    res.send(bot.inventory.items().map(item => ({ name: item.name, count: item.count })));
});

app.post('/api/bots/drop', async (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline.' });

    const items = bot.inventory.items();
    if (items.length === 0) return res.send({ status: 'success', message: 'EMPTY' });

    res.send({ status: 'success', message: 'DROPPING' });
    sendLog(`${bot.originalName} jettisoning...`);

    await bot.waitForTicks(10); 
    for (const item of items) {
        try {
            await bot.tossStack(item);
            await bot.waitForTicks(5); 
        } catch (err) {
            sendLog(`[ERR] Drop failed: ${err.message}`);
        }
    }
});

app.post('/api/bots/potion', (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline.' });

    res.send({ status: 'success', message: 'CONSUMING_POTION' });
    drinkOminousPotion(bot);
});

app.post('/api/bots/potion/start', (req, res) => {
    const botId = req.body.username.toLowerCase();
    const bot = bots[botId];
    if (!bot) return res.status(404).send({ error: 'Bot offline.' });

    drinkOminousPotion(bot);

    if (potionIntervals[botId]) clearInterval(potionIntervals[botId]);
    potionIntervals[botId] = setInterval(() => {
        if (bots[botId]) drinkOminousPotion(bots[botId]);
    }, 2400000);

    sendLog(`Started 40m potion loop for ${bot.originalName}`);
    res.send({ status: 'success', message: 'POTION_LOOP_STARTED' });
});

app.post('/api/bots/potion/stop', (req, res) => {
    const botId = req.body.username.toLowerCase();
    if (potionIntervals[botId]) {
        clearInterval(potionIntervals[botId]);
        delete potionIntervals[botId];
        sendLog(`Stopped potion loop for ${botId.toUpperCase()}`);
        res.send({ status: 'success', message: 'POTION_LOOP_HALTED' });
    } else {
        res.status(400).send({ error: 'Loop not running.' });
    }
});

app.post('/api/bots/attack/start', (req, res) => {
    const response = manageAttackInterval(req.body.username.toLowerCase(), req.body.delay, 'start');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.post('/api/bots/attack/stop', (req, res) => {
    const response = manageAttackInterval(req.body.username.toLowerCase(), null, 'stop');
    res.status(response.status === 'success' ? 200 : 400).send(response);
});

app.listen(process.env.PORT || 3000);
