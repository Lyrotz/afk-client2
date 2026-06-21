const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const { Vec3 } = require('vec3');
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
const bots = {};
const attackIntervals = {};
const attackConfigs = {};
const survivalIntervals = {};
const reconnectTimeouts = {};
const potionIntervals = {};
const potionConfigs = {};
const mineIntervals = {};
const mineConfigs = {};
const clients = [];

const HONEY_BOTTLE_INTERVAL_MS = 39 * 60 * 1000; // 39 minutes

// mineflayer's own bot.blockAtCursor()/blockAtEntityCursor() bails out (returns
// null) whenever entity.pitch or entity.yaw is *exactly* 0, because it checks
// them with a falsy "!entity.pitch" test instead of a proper null check (0 is
// a perfectly valid look angle - dead level pitch, or facing straight along an
// axis - and both are common). That bug means the bot would never find a block
// it's facing if its pitch/yaw happened to be 0. This re-implements the same
// raycast manually with a correct null/undefined check.
function getViewDirection(pitch, yaw) {
	const csPitch = Math.cos(pitch);
	const snPitch = Math.sin(pitch);
	const csYaw = Math.cos(yaw);
	const snYaw = Math.sin(yaw);
	return new Vec3(-snYaw * csPitch, snPitch, -csYaw * csPitch);
}

function getFacedBlock(bot, maxDistance) {
    const entity = bot.entity;
    if (!entity || entity.position == null || entity.height == null || entity.pitch == null || entity.yaw == null) {
        return null;
    }
    const eyePosition = entity.position.offset(0, entity.height, 0);
    const viewDirection = getViewDirection(entity.pitch, entity.yaw);
    
    // Get the raycast intersection
    const match = bot.world.raycast(eyePosition, viewDirection, maxDistance);
    if (!match) return null;
    
    // Fetch and return the actual Block object
    return bot.blockAt(match.position);
}

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
				if (potionConfigs[botId] && potionConfigs[botId].active) {
					sendLog(`Resuming Honey Bottle loop for ${username}...`);
					delete potionIntervals[botId];
					managePotionInterval(botId, 'start');
				}
				if (mineConfigs[botId] && mineConfigs[botId].active) {
					sendLog(`Resuming mine loop for ${username}...`);
					delete mineIntervals[botId];
					manageMineInterval(botId, 'start');
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
	if (mineIntervals[botId]) {
		clearInterval(mineIntervals[botId]);
		delete mineIntervals[botId];
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

function manageMineInterval(botId, action) {
    const bot = bots[botId];
    if (!bot) return { status: 'error', message: 'Bot offline.' };
    const username = bot.originalName;

    if (action === 'start') {
        if (mineIntervals[botId]) return { status: 'error', message: 'Already mining.' };
        mineConfigs[botId] = { active: true };
        sendLog(`Starting line-of-sight mine loop for ${username}.`);
        
        bot.isMining = false; 

        const intervalId = setInterval(async () => {
            const activeBot = bots[botId];
            if (!activeBot || !activeBot.entity) {
                clearInterval(intervalId);
                delete mineIntervals[botId];
                return;
            }

            if (activeBot.targetDigBlock || activeBot.isMining) return;

            // Prevent Mineflayer's null raycast bug
            if (activeBot.entity.pitch === 0) activeBot.entity.pitch = 0.00001;
            if (activeBot.entity.yaw === 0) activeBot.entity.yaw = 0.00001;

            const block = activeBot.blockAtCursor(4.0);

            if (block && block.diggable && !['air', 'water', 'lava'].includes(block.name)) {
                activeBot.isMining = true; 
                try {
                    await activeBot.dig(block, true); 
                } catch (err) {
                    if (err && err.message && !/dig_again|aborted|changed/i.test(err.message)) {
                        sendLog(`[ERR] ${activeBot.originalName} mine error: ${err.message}`);
                    }
                } finally {
                    activeBot.isMining = false; 
                }
            } else {
                activeBot.swingArm('right');
            }
        }, 250);

        mineIntervals[botId] = intervalId;
        return { status: 'success', message: 'Mining started.' };
    }

    if (action === 'stop') {
        if (!mineIntervals[botId]) return { status: 'error', message: 'Not mining.' };
        if (mineConfigs[botId]) mineConfigs[botId].active = false;
        clearInterval(mineIntervals[botId]);
        delete mineIntervals[botId];
        
        if (bot.stopDigging) {
            try { bot.stopDigging(); } catch (err) {}
        }
        bot.isMining = false;
        sendLog(`Stopped mine loop for ${username}.`);
        return { status: 'success', message: 'Mining stopped.' };
    }

    return { status: 'error', message: 'Invalid action.' };
}

function findHoneyBottle(bot) {
	// honey_bottle is a stable vanilla item id, so an exact match is reliable
	// (no need to guess at custom display names).
	return bot.inventory.items().find(item => item.name === 'honey_bottle');
}

async function drinkHoneyBottle(botId) {
	const bot = bots[botId];
	if (!bot) return;
	const item = findHoneyBottle(bot);
	if (!item) {
		sendLog(`${bot.originalName} has no Honey Bottle in inventory, skipping.`);
		return;
	}
	try {
		await bot.equip(item, 'hand');
		await bot.waitForTicks(5);
		bot.activateItem();
		sendLog(`${bot.originalName} drank a Honey Bottle.`);
	} catch (err) {
		sendLog(`[ERR] ${bot.originalName} failed to drink Honey Bottle: ${err.message}`);
	}
}

function managePotionInterval(botId, action) {
	const bot = bots[botId];
	if (!bot) return {
		status: 'error',
		message: 'Bot offline.'
	};
	const username = bot.originalName;
	if (action === 'start') {
		if (potionIntervals[botId]) return {
			status: 'error',
			message: 'Already running.'
		};
		potionConfigs[botId] = {
			active: true
		};
		sendLog(`Starting Honey Bottle loop for ${username} (every 39m).`);
		drinkHoneyBottle(botId);
		const intervalId = setInterval(() => {
			if (bots[botId]) {
				drinkHoneyBottle(botId);
			} else {
				clearInterval(intervalId);
				delete potionIntervals[botId];
			}
		}, HONEY_BOTTLE_INTERVAL_MS);
		potionIntervals[botId] = intervalId;
		return {
			status: 'success',
			message: 'Potion loop started.'
		};
	}
	if (action === 'stop') {
		if (!potionIntervals[botId]) return {
			status: 'error',
			message: 'Not running.'
		};
		if (potionConfigs[botId]) potionConfigs[botId].active = false;
		clearInterval(potionIntervals[botId]);
		delete potionIntervals[botId];
		sendLog(`Stopped Honey Bottle loop for ${username}.`);
		return {
			status: 'success',
			message: 'Potion loop stopped.'
		};
	}
	return {
		status: 'error',
		message: 'Invalid action.'
	};
}
function manageMineInterval(botId, action) {
    const bot = bots[botId];
    if (!bot) return { status: 'error', message: 'Bot offline.' };
    const username = bot.originalName;

    if (action === 'start') {
        if (mineIntervals[botId]) return { status: 'error', message: 'Already mining.' };
        mineConfigs[botId] = { active: true };
        sendLog(`Starting continuous mine loop for ${username} (holding LMB).`);
        
        bot.isMining = false; // Custom lock to prevent packet spam

        const intervalId = setInterval(async () => {
    const activeBot = bots[botId];
    if (!activeBot || !activeBot.entity || activeBot.targetDigBlock || activeBot.isMining) return;

    // Bypass the Mineflayer pitch/yaw === 0 bug
    if (activeBot.entity.pitch === 0) activeBot.entity.pitch = 0.00001;
    if (activeBot.entity.yaw === 0) activeBot.entity.yaw = 0.00001;

    const block = activeBot.blockAtCursor(4.0);

    if (!block || ['air', 'water', 'lava'].includes(block.name) || !block.diggable) {
        return;
    }

    sendLog(`[DEBUG] Attempting to mine: ${block.name} at ${block.position}`);
    activeBot.isMining = true;

    try {
        await activeBot.dig(block, true);
        sendLog(`[DEBUG] Successfully mined: ${block.name}`);
    } catch (err) {
        sendLog(`[DEBUG] Failed to mine ${block.name}: ${err.message}`);
    } finally {
        activeBot.isMining = false;
    }
}, 250);

        mineIntervals[botId] = intervalId;
        return { status: 'success', message: 'Mining started.' };
    }

    if (action === 'stop') {
        if (!mineIntervals[botId]) return { status: 'error', message: 'Not mining.' };
        if (mineConfigs[botId]) mineConfigs[botId].active = false;
        clearInterval(mineIntervals[botId]);
        delete mineIntervals[botId];
        
        if (bot.stopDigging) {
            try {
                bot.stopDigging();
            } catch (err) {}
        }
        bot.isMining = false;
        sendLog(`Stopped mine loop for ${username}.`);
        return { status: 'success', message: 'Mining stopped.' };
    }

    return { status: 'error', message: 'Invalid action.' };
}
app.post('/api/bots/add', (req, res) => {
	const {
		username,
		password
	} = req.body;
	if (initBot(username, password)) {
		res.send({
			status: 'success',
			message: `${username} initiated.`
		});
	} else {
		res.status(400).send({
			status: 'error',
			message: `Bot active.`
		});
	}
});
// NEW: Batch add endpoint with 5-second staggered login
app.post('/api/bots/batch-add', async (req, res) => {
	const {
		accounts
	} = req.body;
	if (!accounts || !Array.isArray(accounts)) {
		return res.status(400).send({
			status: 'error',
			message: 'Invalid payload.'
		});
	}
	res.send({
		status: 'success',
		message: `BATCH_SEQ_STARTED (${accounts.length})`
	});
	sendLog(`[SYS] Initiating batch login for ${accounts.length} units. Delay: 5s per unit.`);
	for (let i = 0; i < accounts.length; i++) {
		const acc = accounts[i];
		if (acc.username && acc.password) {
			initBot(acc.username, acc.password);
			// Wait 5 seconds before starting the next bot, unless it's the last one
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
		res.send({
			status: 'success',
			message: `KILLED_PROCESS: ${botId}`
		});
	} else {
		res.status(404).send({
			status: 'error',
			message: 'NO_PROCESS_FOUND'
		});
	}
});
app.post('/api/bots/chat', (req, res) => {
	const target = req.body.target.toLowerCase();
	const {
		message
	} = req.body;
	if (target === 'all') {
		Object.values(bots).forEach(b => b.chat(message));
		sendLog(`[OUTGOING BROADCAST]: ${message}`);
	} else if (bots[target]) {
		bots[target].chat(message);
		sendLog(`[OUTGOING] ${bots[target].originalName}: ${message}`);
	} else {
		return res.status(404).send({
			status: 'error',
			message: 'Target offline.'
		});
	}
	res.send({
		status: 'success',
		message: 'Message sent.'
	});
});
app.post('/api/bots/hotbar', (req, res) => {
	const botId = req.body.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({
		error: 'Bot offline'
	});
	const slotInt = parseInt(req.body.slot);
	if (isNaN(slotInt) || slotInt < 0 || slotInt > 8) return res.status(400).send({
		error: 'Invalid slot'
	});
	bot.setQuickBarSlot(slotInt);
	sendLog(`${bot.originalName} changed hotbar to ${slotInt}`);
	res.send({
		status: 'success',
		message: `Slot set`
	});
});
app.get('/api/bots/:username/inventory', (req, res) => {
	const botId = req.params.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({
		error: 'Bot offline'
	});
	res.send(bot.inventory.items().map(item => ({
		name: item.name,
		count: item.count
	})));
});
app.post('/api/bots/drop', async (req, res) => {
	const botId = req.body.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({
		error: 'Bot offline.'
	});
	const items = bot.inventory.items();
	if (items.length === 0) return res.send({
		status: 'success',
		message: 'EMPTY'
	});
	res.send({
		status: 'success',
		message: 'DROPPING'
	});
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
app.post('/api/bots/attack/start', (req, res) => {
	const response = manageAttackInterval(req.body.username.toLowerCase(), req.body.delay, 'start');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.post('/api/bots/attack/stop', (req, res) => {
	const response = manageAttackInterval(req.body.username.toLowerCase(), null, 'stop');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.post('/api/bots/potion/start', (req, res) => {
	const response = managePotionInterval(req.body.username.toLowerCase(), 'start');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.post('/api/bots/potion/stop', (req, res) => {
	const response = managePotionInterval(req.body.username.toLowerCase(), 'stop');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.post('/api/bots/mine/start', (req, res) => {
	const response = manageMineInterval(req.body.username.toLowerCase(), 'start');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.post('/api/bots/mine/stop', (req, res) => {
	const response = manageMineInterval(req.body.username.toLowerCase(), 'stop');
	res.status(response.status === 'success' ? 200 : 400).send(response);
});
app.listen(process.env.PORT || 3000);
