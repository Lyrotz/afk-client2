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
const potionConfigs = {};
const sellDropConfigs = {};   // NEW
const clients = [];

const HONEY_BOTTLE_INTERVAL_MS = 39 * 60 * 1000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function sendLog(msg) {
	const logEntry = `[${new Date().toLocaleTimeString()}] ${msg}`;
	console.log(logEntry);
	clients.forEach(client => client.write(`data: ${logEntry}\n\n`));
}

// ── SSE Stream ────────────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache');
	res.setHeader('Connection', 'keep-alive');
	res.flushHeaders();
	clients.push(res);
	req.on('close', () => clients.splice(clients.indexOf(res), 1));
});

// ── Bot list ──────────────────────────────────────────────────────────────────
app.get('/api/bots', (req, res) => {
	const active = Object.values(bots).map(b => b.originalName);
	const pending = Object.keys(reconnectTimeouts).map(id => id.toUpperCase());
	res.send([...new Set([...active, ...pending])]);
});

// ── Position / dimension ──────────────────────────────────────────────────────
app.get('/api/bots/:username/position', (req, res) => {
	const botId = req.params.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline' });
	const pos = bot.entity?.position;
	if (!pos) return res.status(400).send({ error: 'Position unavailable' });
	const rawDim = bot.game?.dimension || 'unknown';
	const dimension = rawDim.replace('minecraft:', ''); // strip namespace for display
	res.send({
		x: Math.floor(pos.x),
		y: Math.floor(pos.y),
		z: Math.floor(pos.z),
		dimension
	});
});

// ── Core bot init ─────────────────────────────────────────────────────────────
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
		username,
		version: '1.19.4'
	});
	bot.originalName = username;
	bot.loginPassword = password;

	bot.once('spawn', () => {
		sendLog(`${username} spawned. Preparing auth...`);
		setTimeout(() => {
			bot.chat(`/register ${password} ${password}`);
			sendLog(`${username} sent /register`);
			setTimeout(() => {
				bot.chat(`/login ${password}`);
				sendLog(`${username} logged in.`);
				setTimeout(() => {
					bot.chat('/survival');
					sendLog(`${username} executed /survival.`);

					survivalIntervals[botId] = setInterval(() => {
						if (bots[botId]) {
							bots[botId].chat('/survival');
							sendLog(`${username} auto-executed /survival (10m loop).`);
						}
					}, 600000);

					if (attackConfigs[botId]?.active) {
						sendLog(`Resuming attack loop for ${username}...`);
						delete attackIntervals[botId];
						manageAttackInterval(botId, attackConfigs[botId].delay, 'start');
					}
					if (potionConfigs[botId]?.active) {
						sendLog(`Resuming Honey Bottle loop for ${username}...`);
						delete potionIntervals[botId];
						managePotionInterval(botId, 'start');
					}
					// Sell/Drop loop does NOT auto-resume after reconnect (safety: avoid unintended drops)
				}, 3000);
			}, 5000);
		}, 2000);
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
	if (attackIntervals[botId]) { clearInterval(attackIntervals[botId]); delete attackIntervals[botId]; }
	if (survivalIntervals[botId]) { clearInterval(survivalIntervals[botId]); delete survivalIntervals[botId]; }
	if (potionIntervals[botId]) { clearInterval(potionIntervals[botId]); delete potionIntervals[botId]; }
	// Mark sell/drop inactive so any in-progress async cycle exits at the next checkpoint
	if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
}

function handleConnectionLoss(username, password, botId) {
	cleanupBotState(botId);
	sendLog(`${username} connection lost. Reconnecting in 30s...`);
	reconnectTimeouts[botId] = setTimeout(() => {
		delete reconnectTimeouts[botId];
		if (!bots[botId]) initBot(username, password);
	}, 30000);
}

// ── Attack ────────────────────────────────────────────────────────────────────
function manageAttackInterval(botId, delaySeconds, action) {
	const bot = bots[botId];
	if (!bot) return { status: 'error', message: 'Bot offline.' };
	const username = bot.originalName;

	if (action === 'start') {
		if (attackIntervals[botId]) return { status: 'error', message: 'Already attacking.' };
		attackConfigs[botId] = { active: true, delay: delaySeconds };
		sendLog(`Starting attack loop for ${username}`);
		const intervalId = setInterval(() => {
			const activeBot = bots[botId];
			if (activeBot && activeBot.entity) {
				activeBot.setControlState('sprint', false);
				activeBot.setControlState('jump', false);
				const target = activeBot.nearestEntity(entity =>
					entity.name === 'armor_stand' && entity.position.distanceTo(activeBot.entity.position) < 4
				);
				if (target) activeBot.attack(target);
				else activeBot.swingArm('right');
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

// ── Honey Bottle ──────────────────────────────────────────────────────────────
function findHoneyBottle(bot) {
	return bot.inventory.items().find(item => item.name === 'honey_bottle');
}

async function drinkHoneyBottle(botId) {
	const bot = bots[botId];
	if (!bot) return;
	const item = findHoneyBottle(bot);
	if (!item) { sendLog(`${bot.originalName} has no Honey Bottle, skipping.`); return; }
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
	if (!bot) return { status: 'error', message: 'Bot offline.' };
	const username = bot.originalName;
	if (action === 'start') {
		if (potionIntervals[botId]) return { status: 'error', message: 'Already running.' };
		potionConfigs[botId] = { active: true };
		sendLog(`Starting Honey Bottle loop for ${username} (every 39m).`);
		drinkHoneyBottle(botId);
		const intervalId = setInterval(() => {
			if (bots[botId]) drinkHoneyBottle(botId);
			else { clearInterval(intervalId); delete potionIntervals[botId]; }
		}, HONEY_BOTTLE_INTERVAL_MS);
		potionIntervals[botId] = intervalId;
		return { status: 'success', message: 'Potion loop started.' };
	}
	if (action === 'stop') {
		if (!potionIntervals[botId]) return { status: 'error', message: 'Not running.' };
		if (potionConfigs[botId]) potionConfigs[botId].active = false;
		clearInterval(potionIntervals[botId]);
		delete potionIntervals[botId];
		sendLog(`Stopped Honey Bottle loop for ${username}.`);
		return { status: 'success', message: 'Potion loop stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Sell + Drop Loop ──────────────────────────────────────────────────────────
// Cycle: /sellall PRISMARINE_CRYSTALS → 10s → /sellall PRISMARINE_SHARD → 10s
//        → /sellall COD → 10s → wait 5s → drop all → wait 10s → repeat

async function executeSellDropCycle(botId) {
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;
	const name = bots[botId].originalName;
	sendLog(`${name} starting sell/drop cycle.`);

	bots[botId].chat('/sellall PRISMARINE_CRYSTALS');
	sendLog(`${name} → /sellall PRISMARINE_CRYSTALS`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	bots[botId].chat('/sellall PRISMARINE_SHARD');
	sendLog(`${name} → /sellall PRISMARINE_SHARD`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	bots[botId].chat('/sellall COD');
	sendLog(`${name} → /sellall COD`);
	await sleep(10000);
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	await sleep(5000); // extra 5s after last sell
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	// Drop all inventory
	const bot = bots[botId];
	const items = bot.inventory.items();
	sendLog(`${name} dropping ${items.length} stack(s)...`);
	await bot.waitForTicks(10);
	for (const item of items) {
		if (!bots[botId] || !sellDropConfigs[botId]?.active) return;
		try {
			await bots[botId].tossStack(item);
			await bots[botId].waitForTicks(5);
		} catch (err) {
			sendLog(`[ERR] ${name} drop: ${err.message}`);
		}
	}
	sendLog(`${name} dropped all items.`);

	await sleep(10000); // 10s before next cycle
	if (!bots[botId] || !sellDropConfigs[botId]?.active) return;

	executeSellDropCycle(botId); // recurse
}

function manageSellDropLoop(botId, action) {
	if (action === 'start') {
		if (!bots[botId]) return { status: 'error', message: 'Bot offline.' };
		if (sellDropConfigs[botId]?.active) return { status: 'error', message: 'Already running.' };
		sellDropConfigs[botId] = { active: true };
		sendLog(`Starting sell/drop loop for ${bots[botId].originalName}.`);
		executeSellDropCycle(botId);
		return { status: 'success', message: 'Sell/Drop loop started.' };
	}
	if (action === 'stop') {
		const name = bots[botId]?.originalName || botId;
		if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
		delete sellDropConfigs[botId];
		sendLog(`Sell/Drop loop stopped for ${name}.`);
		return { status: 'success', message: 'Sell/Drop loop stopped.' };
	}
	return { status: 'error', message: 'Invalid action.' };
}

// ── Warp Arena (all bots) ─────────────────────────────────────────────────────
// Sequence: /warp arena → wait 3s → drop all items → /back

app.post('/api/bots/warp-arena', async (req, res) => {
	const allBots = Object.values(bots);
	if (allBots.length === 0) return res.status(404).send({ status: 'error', message: 'No bots online.' });

	res.send({ status: 'success', message: `Warp Arena sequence: ${allBots.length} bot(s)` });

	// Step 1 — all bots warp simultaneously
	allBots.forEach(bot => {
		bot.chat('/warp arena');
		sendLog(`${bot.originalName} → /warp arena`);
	});

	await sleep(3000);

	// Step 2 — each bot drops inventory then /back (parallel)
	await Promise.all(allBots.map(async (bot) => {
		const botId = bot.originalName.toLowerCase();
		const liveBot = bots[botId];
		if (!liveBot) return;

		const items = liveBot.inventory.items();
		await liveBot.waitForTicks(5);
		for (const item of items) {
			if (!bots[botId]) break;
			try {
				await bots[botId].tossStack(item);
				await bots[botId].waitForTicks(5);
			} catch (err) {
				sendLog(`[ERR] ${bot.originalName} warp-arena drop: ${err.message}`);
			}
		}
		sendLog(`${bot.originalName} dropped all items (arena).`);

		if (bots[botId]) {
			bots[botId].chat('/back');
			sendLog(`${bot.originalName} → /back`);
		}
	}));
});

// ── REST Endpoints ─────────────────────────────────────────────────────────────
app.post('/api/bots/add', (req, res) => {
	const { username, password } = req.body;
	if (initBot(username, password)) {
		res.send({ status: 'success', message: `${username} initiated.` });
	} else {
		res.status(400).send({ status: 'error', message: 'Bot already active.' });
	}
});

app.post('/api/bots/batch-add', async (req, res) => {
	const { accounts } = req.body;
	if (!accounts || !Array.isArray(accounts))
		return res.status(400).send({ status: 'error', message: 'Invalid payload.' });
	res.send({ status: 'success', message: `Batch started (${accounts.length} accounts)` });
	sendLog(`[SYS] Batch login: ${accounts.length} accounts, 5s delay each.`);
	for (let i = 0; i < accounts.length; i++) {
		const acc = accounts[i];
		if (acc.username && acc.password) {
			initBot(acc.username, acc.password);
			if (i < accounts.length - 1) await sleep(5000);
		}
	}
	sendLog(`[SYS] Batch login sequence complete.`);
});

app.post('/api/bots/disconnect', (req, res) => {
	const botId = req.body.username.toLowerCase();
	let actionTaken = false;
	if (reconnectTimeouts[botId]) {
		clearTimeout(reconnectTimeouts[botId]);
		delete reconnectTimeouts[botId];
		sendLog(`[SYS] Cancelled pending reconnect for ${botId}`);
		actionTaken = true;
	}
	if (attackConfigs[botId]) attackConfigs[botId].active = false;
	if (sellDropConfigs[botId]) sellDropConfigs[botId].active = false;
	if (bots[botId]) { bots[botId].quit(); actionTaken = true; }
	if (actionTaken) res.send({ status: 'success', message: `Disconnected: ${botId}` });
	else res.status(404).send({ status: 'error', message: 'Bot not found.' });
});

app.post('/api/bots/chat', (req, res) => {
	const target = req.body.target.toLowerCase();
	const { message } = req.body;
	if (target === 'all') {
		Object.values(bots).forEach(b => b.chat(message));
		sendLog(`[BROADCAST]: ${message}`);
	} else if (bots[target]) {
		bots[target].chat(message);
		sendLog(`[OUTGOING] ${bots[target].originalName}: ${message}`);
	} else {
		return res.status(404).send({ status: 'error', message: 'Target offline.' });
	}
	res.send({ status: 'success', message: 'Sent.' });
});

app.post('/api/bots/hotbar', (req, res) => {
	const botId = req.body.username.toLowerCase();
	const bot = bots[botId];
	if (!bot) return res.status(404).send({ error: 'Bot offline' });
	const slotInt = parseInt(req.body.slot);
	if (isNaN(slotInt) || slotInt < 0 || slotInt > 8)
		return res.status(400).send({ error: 'Invalid slot' });
	bot.setQuickBarSlot(slotInt);
	sendLog(`${bot.originalName} hotbar → slot ${slotInt + 1}`);
	res.send({ status: 'success', message: `Slot set to ${slotInt + 1}` });
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
	if (items.length === 0) return res.send({ status: 'success', message: 'Inventory already empty.' });
	res.send({ status: 'success', message: 'Dropping...' });
	sendLog(`${bot.originalName} dropping inventory...`);
	await bot.waitForTicks(10);
	for (const item of items) {
		try { await bot.tossStack(item); await bot.waitForTicks(5); }
		catch (err) { sendLog(`[ERR] Drop: ${err.message}`); }
	}
	sendLog(`${bot.originalName} finished dropping.`);
});

app.post('/api/bots/attack/start', (req, res) => {
	const r = manageAttackInterval(req.body.username.toLowerCase(), req.body.delay, 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/attack/stop', (req, res) => {
	const r = manageAttackInterval(req.body.username.toLowerCase(), null, 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/potion/start', (req, res) => {
	const r = managePotionInterval(req.body.username.toLowerCase(), 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/potion/stop', (req, res) => {
	const r = managePotionInterval(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/selldrop/start', (req, res) => {
	const r = manageSellDropLoop(req.body.username.toLowerCase(), 'start');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});
app.post('/api/bots/selldrop/stop', (req, res) => {
	const r = manageSellDropLoop(req.body.username.toLowerCase(), 'stop');
	res.status(r.status === 'success' ? 200 : 400).send(r);
});

app.listen(process.env.PORT || 3000, () => {
	console.log(`Tulpar Bot Manager running on port ${process.env.PORT || 3000}`);
});
