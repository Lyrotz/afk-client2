const mineflayer = require("mineflayer")
const WebSocket = require("ws")

const SERVER_URL = "wss://afk-server-production-c4a4.up.railway.app"
const BOT_DEFAULTS = {
    host: 'play.tulparmc.com',
    port: 25565,
    version: "1.19.4",
}

const activeBots = new Map()
const registeredBots = new Set()
const deletedBots = new Set()
let ws

let spawnQueue = Promise.resolve()

function queueCreateBot(username) {
    deletedBots.delete(username)
    spawnQueue = spawnQueue.then(() => {
        if (!deletedBots.has(username)) createBot(username)
        return new Promise(resolve => setTimeout(resolve, 5000))
    })
}

function createBot(username) {
    if (deletedBots.has(username)) return

    const bot = mineflayer.createBot({ ...BOT_DEFAULTS, username })

    bot.on("error", (err) => {
        console.log(`${username} error: ${JSON.stringify(err.message)}`)
        clearInterval(bot._survivalInterval)
        activeBots.delete(username)
        sendBotList()
        if (!deletedBots.has(username)) setTimeout(() => createBot(username), 30000)
    })

    bot.on("spawn", () => {
        activeBots.set(username, bot)
        sendBotList()

        if (!registeredBots.has(username)) {
            setTimeout(() => bot.chat("/register asdasd123 asdasd123"), 3000)
            setTimeout(() => bot.chat("/login asdasd123"), 8000)
            setTimeout(() => { registeredBots.add(username); bot.chat("/survival") }, 12000)
        } else {
            setTimeout(() => bot.chat("/login asdasd123"), 3000)
            setTimeout(() => bot.chat("/survival"), 8000)
        }

        bot._survivalInterval = setInterval(() => bot.chat("/survival"), 10 * 60 * 1000)
    })

    bot.on("kicked", (reason) => {
        console.log(`${username} kicked: ${JSON.stringify(reason)}`)
        clearInterval(bot._survivalInterval)
        activeBots.delete(username)
        sendBotList()
        if (!deletedBots.has(username)) setTimeout(() => createBot(username), 30000)
    })

    bot.on("end", () => {
        console.log(`${username} ended`)
        clearInterval(bot._survivalInterval)
        activeBots.delete(username)
        sendBotList()
        if (!deletedBots.has(username)) setTimeout(() => createBot(username), 30000)
    })

    activeBots.set(username, bot)
}

function deleteBot(username) {
    deletedBots.add(username)
    const bot = activeBots.get(username)
    if (!bot) return
    clearInterval(bot._survivalInterval)
    bot.quit("removed by panel")
    activeBots.delete(username)
    sendBotList()
}

function sendMessage(username, message) {
    if (username === "__all__") { for (const bot of activeBots.values()) bot.chat(message); return }
    const bot = activeBots.get(username)
    if (bot) bot.chat(message)
}

async function dropAll(username) {
    const bot = activeBots.get(username)
    if (!bot) return
    for (const item of bot.inventory.items()) await bot.tossStack(item)
}

function sendBotList() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: "botList", bots: Array.from(activeBots.keys()) }))
}

function handleCommand(cmd) {
    if (cmd.type === "createBot") return queueCreateBot(cmd.username)
    if (cmd.type === "deleteBot") return deleteBot(cmd.username)
    if (cmd.type === "sendMessage") return sendMessage(cmd.username, cmd.message)
    if (cmd.type === "dropAll") return dropAll(cmd.username)
}

function connect() {
    ws = new WebSocket(SERVER_URL)
    ws.on("open", () => {
        console.log("connected to server")
        ws.send(JSON.stringify({ type: "register", role: "bot-worker" }))
        sendBotList()
    })
    ws.on("message", (msg) => {
        const data = JSON.parse(msg)
        handleCommand(data.payload || data)
    })
    ws.on("close", () => {
        console.log("disconnected, retrying in 30s...")
        setTimeout(connect, 30000)
    })
    ws.on("error", () => ws.close())
}

connect()
