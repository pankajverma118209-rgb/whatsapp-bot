const mongoose = require('mongoose');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { toDataURL } = require('qrcode');
const express = require('express');
const cookieParser = require('cookie-parser');
const pino = require('pino');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(cookieParser('pankaj_secret_key_123'));

const PORT = process.env.PORT || 3000;
let qrCodeData = '';
let isConnected = false;
let sock;
let activeSessionToken = '';
let myProfileName = 'Pankaj WhatsApp';
let myProfilePic = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_1280.png';

let presenceMap = {};

// MongoDB Connection
mongoose.connect('mongodb+srv://pankajverma118209_db_user:NnH6aCj5VYeTnb18@cluster0.7tnmbt8.mongodb.net/', {
    serverSelectionTimeoutMS: 5000
}).then(() => {
    console.log("🔥 MongoDB Connected Successfully!");
}).catch(err => {
    console.log("❌ Database Connection Failed: ", err);
});

// Robust Message Schema
const messageSchema = new mongoose.Schema({
    remoteJid: { type: String, required: true },
    id: { type: String, required: true },
    sender: { type: String },
    pushName: { type: String },
    messageText: { type: String },
    mediaType: { type: String },
    fromMe: { type: Boolean },
    timestamp: { type: Number },
    status: { type: String, default: 'delivered' },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Number }
});

const SavedMessage = mongoose.model('SavedMessage', messageSchema);

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await toDataURL(qr);
            isConnected = false;
            activeSessionToken = '';
        }

        if (connection === 'close') {
            qrCodeData = '';
            isConnected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            qrCodeData = '';
            isConnected = true;
            if (!activeSessionToken) {
                activeSessionToken = crypto.randomBytes(32).toString('hex');
            }
            
            try {
                const userJid = sock.user.id;
                myProfileName = sock.user.name || userJid.split('@')[0];
                try {
                    myProfilePic = await sock.profilePictureUrl(userJid, 'image').catch(() => myProfilePic);
                } catch(e) {}
            } catch(e) {}
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('presence.update', (json) => {
        const { id, presences } = json;
        if (presences && presences[id]) {
            const p = presences[id];
            if (p.lastKnownPresence === 'available') {
                presenceMap[id] = { isOnline: true, lastSeen: '' };
            } else if (p.lastKnownPresence === 'unavailable') {
                let timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                presenceMap[id] = { isOnline: false, lastSeen: `Last seen today at ${timeStr}` };
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify' || type === 'append') {
            for (const msg of messages) {
                const jid = msg.key.remoteJid;
                if (!jid || jid.includes('status@broadcast')) continue;
                
                let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
                let mType = 'text';

                if (msg.message?.imageMessage) { text = text || '[Image]'; mType = 'image'; }
                else if (msg.message?.videoMessage) { text = text || '[Video]'; mType = 'video'; }
                else if (msg.message?.audioMessage) { text = '[Voice Note]'; mType = 'audio'; }
                else if (msg.message?.documentMessage) { text = `[Document: ${msg.message.documentMessage.fileName || 'File'}]`; mType = 'document'; }
                else if (!text) { text = '[Media/File]'; }
                
                let resolvedName = msg.pushName;
                let cleanPhone = '+' + jid.split('@')[0];
                
                if (!resolvedName) resolvedName = cleanPhone;
                if (msg.key.fromMe) resolvedName = 'Me';

                const fromMe = msg.key.fromMe;
                const msgId = msg.key.id;
                const msgTimestamp = (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now());

                try {
                    await SavedMessage.findOneAndUpdate(
                        { remoteJid: jid, id: msgId },
                        {
                            remoteJid: jid,
                            id: msgId,
                            sender: resolvedName,
                            pushName: resolvedName,
                            messageText: text,
                            mediaType: mType,
                            fromMe: fromMe,
                            timestamp: msgTimestamp,
                            status: 'delivered'
                        },
                        { upsert: true, returnDocument: 'after' }
                    );
                } catch (e) {
                    console.log("Error saving to DB:", e);
                }
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update && update.update.message === null) {
                const deletedMsgId = update.key.id;
                const chatJid = update.key.remoteJid;

                try {
                    await SavedMessage.findOneAndUpdate(
                        { remoteJid: chatJid, id: deletedMsgId },
                        { isDeleted: true, deletedAt: Date.now() }
                    );
                } catch(e) {}
            }
        }
    });
}

connectToWhatsApp();

function authMiddleware(req, res, next) {
    const userCookie = req.cookies.device_session;
    if (isConnected && userCookie && userCookie === activeSessionToken) {
        next();
    } else {
        res.status(401).json({ error: "Unauthorized device" });
    }
}

app.get('/api/chats', authMiddleware, async (req, res) => {
    try {
        const allMsgs = await SavedMessage.find({}).sort({ timestamp: 1 });
        let chatsMap = {};

        for (const m of allMsgs) {
            let cleanPhone = '+' + m.remoteJid.split('@')[0];
            let chatName = m.pushName;
            
            if (!chatName || chatName === 'Me' || chatName === cleanPhone) {
                chatName = cleanPhone;
            }

            let ppUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_1280.png';
            try {
                if (sock && typeof sock.profilePictureUrl === 'function') {
                    ppUrl = await sock.profilePictureUrl(m.remoteJid, 'image').catch(() => ppUrl);
                }
            } catch(e) {}

            chatsMap[m.remoteJid] = {
                id: m.remoteJid,
                name: chatName,
                phone: cleanPhone,
                lastMsg: m.isDeleted ? '🚫 [Message Deleted]' : m.messageText,
                pic: ppUrl
            };
        }

        res.json({ 
            chats: Object.values(chatsMap), 
            isConnected: isConnected,
            myName: myProfileName,
            myPic: myProfilePic
        });
    } catch (e) {
        res.json({ chats: [], isConnected: isConnected, myName: myProfileName, myPic: myProfilePic });
    }
});

app.get('/api/presence/:jid', authMiddleware, async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        if (sock) {
            await sock.presenceSubscribe(jid).catch(() => {});
        }
        const pInfo = presenceMap[jid] || { isOnline: false, lastSeen: 'Offline' };
        res.json(pInfo);
    } catch(e) {
        res.json({ isOnline: false, lastSeen: 'Offline' });
    }
});

app.get('/api/messages/:jid', authMiddleware, async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
        const messages = await SavedMessage.find({ remoteJid: jid }).sort({ timestamp: 1 });
        const formatted = messages.map(m => {
            let dateObj = new Date(m.timestamp || Date.now());
            let timeString = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            let todayStr = new Date().toDateString();
            let msgDateStr = dateObj.toDateString();
            let dateSeparator = msgDateStr === todayStr ? 'Today' : dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

            let deletedTimeString = '';
            if (m.isDeleted && m.deletedAt) {
                let delDate = new Date(m.deletedAt);
                deletedTimeString = delDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            return {
                id: m.id,
                text: m.messageText,
                mediaType: m.mediaType,
                fromMe: m.fromMe,
                isDeleted: m.isDeleted,
                time: timeString,
                deletedTime: deletedTimeString,
                dateSeparator: dateSeparator,
                status: m.status
            };
        });
        res.json({ messages: formatted });
    } catch (e) {
        res.json({ messages: [] });
    }
});

app.post('/send', authMiddleware, async (req, res) => {
    const { jid, message } = req.body;
    if (sock && jid && message) {
        try {
            const sent = await sock.sendMessage(jid, { text: message });
            await SavedMessage.create({
                remoteJid: jid,
                id: sent?.key?.id || ('sent_' + Date.now()),
                sender: 'Me',
                pushName: 'Me',
                messageText: message,
                fromMe: true,
                timestamp: Date.now(),
                status: 'read'
            });
            res.json({ status: 'success' });
        } catch (e) {
            res.status(500).json({ status: 'error' });
        }
    } else {
        res.status(400).json({ status: 'error' });
    }
});

app.get('/logout', async (req, res) => {
    try {
        if (sock) { try { await sock.logout(); } catch(e) {} }
        isConnected = false;
        qrCodeData = '';
        activeSessionToken = '';
        res.clearCookie('device_session');
        
        const authPath = path.join(__dirname, 'auth_info_baileys');
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
        res.redirect('/');
        setTimeout(() => { process.exit(0); }, 1000);
    } catch(e) {
        res.redirect('/');
    }
});

app.get('/clear-database', authMiddleware, async (req, res) => {
    try {
        await SavedMessage.deleteMany({});
        res.redirect('/');
    } catch(e) {
        res.redirect('/');
    }
});

app.get('/', (req, res) => {
    const userCookie = req.cookies.device_session;

    if (isConnected && userCookie && userCookie === activeSessionToken) {
        res.send(`
            <!DOCTYPE html>
            <html lang="hi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Pankaj WhatsApp Access</title>
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
                    body { background: #00a884; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
                    .wa-container { display: flex; width: 100vw; height: 100vh; background: #f0f2f5; position: relative; }
                    .sidebar { width: 38vw; min-width: 320px; background: #ffffff; border-right: 1px solid #d1d7db; display: flex; flex-direction: column; height: 100%; }
                    
                    .sidebar-header { height: 68px; background: #111b21; display: flex; justify-content: space-between; align-items: center; padding: 0 16px; border-bottom: 1px solid #222d34; overflow: hidden; position: relative; }
                    .my-profile { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; color: #ffffff; overflow: hidden; max-width: 30%; z-index: 2; background: #111b21; cursor: pointer; }
                    .my-avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: #00a884; flex-shrink: 0; border: 2px solid #00ffcc; }
                    .my-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    
                    @keyframes staticNeonGlow {
                        0% { text-shadow: 0 0 5px #ff007f, 0 0 10px #00ffcc; }
                        50% { text-shadow: 0 0 15px #ffe500, 0 0 25px #ff007f, 0 0 35px #00ffff; }
                        100% { text-shadow: 0 0 5px #ff007f, 0 0 10px #00ffcc; }
                    }
                    .dev-tag {
                        font-size: 13px; font-weight: 900;
                        background: linear-gradient(90deg, #ffe500, #ff007f, #00ffff, #00ffcc, #ff4500, #ffe500);
                        -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                        text-transform: uppercase; white-space: nowrap;
                        animation: staticNeonGlow 2s ease-in-out infinite; letter-spacing: 0.8px;
                        text-align: center; position: absolute; left: 50%; transform: translateX(-50%); z-index: 1;
                    }

                    .menu-container { position: relative; z-index: 10; }
                    .dot-btn { background: none; border: none; color: #aebac1; font-size: 22px; cursor: pointer; padding: 5px 8px; border-radius: 50%; }
                    .dot-btn:hover { background: #222d34; color: #fff; }
                    .dropdown-menu { display: none; position: absolute; right: 0; top: 40px; background: #233138; box-shadow: 0 4px 12px rgba(0,0,0,0.3); border-radius: 4px; width: 160px; overflow: hidden; }
                    .dropdown-menu a { display: block; padding: 12px 16px; color: #e9edef; text-decoration: none; font-size: 13px; transition: background 0.2s; }
                    .dropdown-menu a:hover { background: #182229; color: #00a884; font-weight: bold; }

                    .chats-list { flex: 1; overflow-y: auto; background: #ffffff; }
                    .chat-item { display: flex; align-items: center; padding: 12px 16px; gap: 15px; border-bottom: 1px solid #f2f2f2; cursor: pointer; transition: background 0.2s; }
                    .chat-item:hover { background: #f5f6f6; }
                    .chat-item.active { background: #f0f2f5; }
                    .chat-dp { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; background: #dfe1e5; flex-shrink: 0; }
                    .chat-info { flex: 1; overflow: hidden; }
                    .chat-row-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
                    .chat-name { font-size: 16px; font-weight: 500; color: #111b21; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    .chat-preview { font-size: 13px; color: #667781; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                    
                    .chat-panel { flex: 1; display: flex; flex-direction: column; background: #efeae2; height: 100%; position: relative; }
                    .chat-panel-header { height: 68px; background: #f0f2f5; padding: 0 16px; display: flex; align-items: center; gap: 15px; border-bottom: 1px solid #d1d7db; cursor: pointer; }
                    .panel-dp { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
                    .panel-name { font-size: 16px; font-weight: 600; color: #111b21; }
                    .presence-status { font-size: 12px; color: #00a884; font-weight: 600; display: block; }
                    
                    .messages-area { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; background-image: url('https://user-images.githubusercontent.com/15075759/28719144-86ed0f0a-7156-11e7-8832-720a4b0d0611.png'); background-repeat: repeat; }
                    .date-separator { align-self: center; background: #e3e1da; color: #54656f; font-size: 12px; padding: 5px 12px; border-radius: 6px; margin: 10px 0; font-weight: 500; box-shadow: 0 1px 0.5px rgba(0,0,0,0.1); }
                    
                    .message { max-width: 65%; padding: 8px 12px 22px 12px; border-radius: 8px; font-size: 14px; word-break: break-word; position: relative; box-shadow: 0 1px 0.5px rgba(0,0,0,0.13); }
                    .message.sent { background: #d9fdd3; color: #111b21; align-self: flex-end; border-top-right-radius: 0; }
                    .message.received { background: #ffffff; color: #111b21; align-self: flex-start; border-top-left-radius: 0; }
                    .message.deleted { background: #ffebee; color: #c62828; border: 1px dashed #ef9a9a; }
                    .msg-meta { font-size: 10px; color: #667781; position: absolute; bottom: 4px; right: 8px; display: flex; align-items: center; gap: 3px; }
                    .msg-del-time { font-size: 10px; color: #b71c1c; display: block; margin-top: 4px; font-weight: bold; }
                    .tick { font-weight: bold; font-size: 12px; color: #53bdeb; }

                    .input-panel { height: 62px; background: #f0f2f5; display: flex; align-items: center; padding: 0 16px; gap: 12px; border-top: 1px solid #d1d7db; }
                    .input-panel input { flex: 1; height: 42px; background: #ffffff; border: none; outline: none; padding: 0 15px; border-radius: 8px; font-size: 15px; color: #111b21; }
                    .send-btn { background: #00a884; color: white; border: none; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-weight: bold; font-size: 16px; }

                    .profile-drawer { display: none; width: 28vw; background: #ffffff; border-left: 1px solid #d1d7db; flex-direction: column; height: 100%; }
                    .drawer-header { height: 68px; background: #f0f2f5; padding: 0 16px; display: flex; align-items: center; gap: 15px; font-weight: 600; font-size: 16px; border-bottom: 1px solid #d1d7db; }
                    .drawer-body { padding: 20px; text-align: center; overflow-y: auto; }
                    .drawer-dp { width: 120px; height: 120px; border-radius: 50%; object-fit: cover; margin-bottom: 15px; border: 3px solid #00a884; }
                </style>
            </head>
            <body>
                <div class="wa-container">
                    <div class="sidebar">
                        <div class="sidebar-header">
                            <div class="my-profile" onclick="alert('Developer: Pankaj Verma')">
                                <img src="" id="myAvatarImg" class="my-avatar" alt="DP" />
                                <span class="my-name" id="myProfileName">Loading...</span>
                            </div>
                            <div class="dev-tag">DEVELOPER ➜ PANKAJ VERMA 😈</div>
                            <div class="menu-container">
                                <button class="dot-btn" onclick="toggleMenu(event)">⋮</button>
                                <div class="dropdown-menu" id="dropdownMenu">
                                    <a href="/logout" onclick="return confirm('Logout karenge tab bhi purana DB data retained raheगा. Continue?');">Logout (Keep Data)</a>
                                    <a href="/clear-database" style="color:#ff5252;" onclick="return confirm('KAYA AAP SACH ME SARA PURANA DATA DELETE KARNA CHAHTE HAIN?');">Clear Database</a>
                                </div>
                            </div>
                        </div>
                        <div class="chats-list" id="chatsContainer">
                            <div style="padding: 20px; text-align: center; color: #667781; font-size: 14px;">Syncing chats from database...</div>
                        </div>
                    </div>
                    
                    <div class="chat-panel">
                        <div class="chat-panel-header" id="panelHeader" onclick="toggleProfileDrawer()">
                            <div class="panel-name" style="color: #667781;">Select a chat from sidebar</div>
                        </div>
                        <div class="messages-area" id="messagesContainer">
                            <div style="background: #fff; padding: 8px 16px; border-radius: 8px; align-self: center; font-size: 12px; color: #54656f; box-shadow: 0 1px 0.5px rgba(0,0,0,0.1);">🔒 Protected Session (History Restored & Safe)</div>
                        </div>
                        <div class="input-panel" id="inputPanel" style="display: none;">
                            <input type="text" id="msgInput" placeholder="Type a message" onkeypress="checkEnter(event)" />
                            <button class="send-btn" onclick="sendMsg()">➤</button>
                        </div>
                    </div>

                    <div class="profile-drawer" id="profileDrawer">
                        <div class="drawer-header">
                            <span style="cursor: pointer;" onclick="toggleProfileDrawer()">✕</span>
                            <span>Contact Info</span>
                        </div>
                        <div class="drawer-body">
                            <img src="" id="drawerDp" class="drawer-dp" alt="DP" />
                            <h3 id="drawerName" style="color: #111b21; margin-bottom: 5px;">-</h3>
                            <p id="drawerPhone" style="color: #667781; font-size: 14px; margin-bottom: 20px;">-</p>
                        </div>
                    </div>
                </div>

                <script>
                    let activeJid = '';
                    let chatsStore = {};
                    let presenceTimer = null;

                    function toggleMenu(e) { e.stopPropagation(); const menu = document.getElementById('dropdownMenu'); menu.style.display = (menu.style.display === 'block') ? 'none' : 'block'; }
                    window.onclick = function() { document.getElementById('dropdownMenu').style.display = 'none'; }
                    function toggleProfileDrawer() { const drawer = document.getElementById('profileDrawer'); drawer.style.display = (drawer.style.display === 'flex') ? 'none' : 'flex'; }

                    async function fetchPresence(jid) {
                        try {
                            const res = await fetch('/api/presence/' + encodeURIComponent(jid));
                            const data = await res.json();
                            const pElem = document.getElementById('chatPresenceStatus');
                            if (pElem) {
                                if (data.isOnline) {
                                    pElem.innerText = 'Online';
                                    pElem.style.color = '#00a884';
                                } else {
                                    pElem.innerText = data.lastSeen || 'Offline';
                                    pElem.style.color = '#667781';
                                }
                            }
                        } catch(e) {}
                    }

                    async function fetchChats() {
                        try {
                            const res = await fetch('/api/chats');
                            if (res.status === 401) { window.location.reload(); return; }
                            const data = await res.json();
                            
                            if (data.myName) document.getElementById('myProfileName').innerText = data.myName;
                            if (data.myPic) document.getElementById('myAvatarImg').src = data.myPic;

                            const container = document.getElementById('chatsContainer');
                            if (!data.chats || data.chats.length === 0) return;
                            
                            let html = '';
                            data.chats.forEach(chat => {
                                chatsStore[chat.id] = chat;
                                let activeClass = (activeJid === chat.id) ? 'active' : '';
                                html += \`
                                    <div class="chat-item \${activeClass}" onclick="openChat('\${chat.id}')">
                                        <img src="\${chat.pic}" class="chat-dp" alt="DP" />
                                        <div class="chat-info">
                                            <div class="chat-row-top"><div class="chat-name">\${chat.name}</div></div>
                                            <div class="chat-preview">\${chat.phone}</div>
                                        </div>
                                    </div>
                                \`;
                            });
                            container.innerHTML = html;
                        } catch(e) {}
                    }

                    async function openChat(jid) {
                        activeJid = jid;
                        let chat = chatsStore[jid];
                        if(chat) {
                            document.getElementById('panelHeader').innerHTML = \`
                                <img src="\${chat.pic}" class="panel-dp" alt="DP" />
                                <div>
                                    <div class="panel-name">\${chat.name}</div>
                                    <span class="presence-status" id="chatPresenceStatus">Checking presence...</span>
                                </div>
                            \`;
                            document.getElementById('drawerDp').src = chat.pic;
                            document.getElementById('drawerName').innerText = chat.name;
                            document.getElementById('drawerPhone').innerText = chat.phone;
                        }
                        document.getElementById('inputPanel').style.display = 'flex';
                        fetchChats();

                        if (presenceTimer) clearInterval(presenceTimer);
                        fetchPresence(jid);
                        presenceTimer = setInterval(() => fetchPresence(jid), 3000);

                        const res = await fetch('/api/messages/' + encodeURIComponent(jid));
                        const data = await res.json();
                        const msgBox = document.getElementById('messagesContainer');
                        msgBox.innerHTML = '';
                        
                        let lastDate = '';
                        data.messages.forEach(m => {
                            if (m.dateSeparator !== lastDate) {
                                lastDate = m.dateSeparator;
                                msgBox.innerHTML += \`<div class="date-separator">\${lastDate}</div>\`;
                            }

                            let typeClass = m.fromMe ? 'sent' : 'received';
                            let content = m.text;
                            if (m.isDeleted) {
                                typeClass += ' deleted';
                                content = \`🚫 [Deleted Message]: \${m.text} <span class="msg-del-time">Deleted at: \${m.deletedTime}</span>\`;
                            }
                            let ticks = m.fromMe ? '<span class="tick">✓✓</span>' : '';
                            msgBox.innerHTML += \`<div class="message \${typeClass}">\${content}<div class="msg-meta"><span>\${m.time}</span>\${ticks}</div></div>\`;
                        });
                        msgBox.scrollTop = msgBox.scrollHeight;
                    }

                    async function sendMsg() {
                        let text = document.getElementById('msgInput').value.trim();
                        if (!text || !activeJid) return;
                        await fetch('/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jid: activeJid, message: text })
                        });
                        let msgBox = document.getElementById('messagesContainer');
                        let currentTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        msgBox.innerHTML += \`<div class="message sent">\${text}<div class="msg-meta"><span>\${currentTime}</span><span class="tick">✓✓</span></div></div>\`;
                        document.getElementById('msgInput').value = '';
                        msgBox.scrollTop = msgBox.scrollHeight;
                    }

                    function checkEnter(e) { if (e.key === 'Enter') sendMsg(); }
                    setInterval(fetchChats, 3000);
                    fetchChats();
                </script>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="hi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Pankaj WhatsApp Access</title>
                <meta http-equiv="refresh" content="3">
                <style>
                    body { background: #00a884; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                    .login-card { background: #ffffff; width: 380px; padding: 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); text-align: center; }
                    .brand { font-size: 16px; font-weight: 900; background: linear-gradient(90deg, #059669, #2563eb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-transform: uppercase; margin-bottom: 15px; }
                    h2 { color: #111b21; font-size: 22px; margin-bottom: 5px; }
                    .status { color: #00a884; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
                    .qr-box { background: #fff; padding: 10px; display: inline-block; border: 2px solid #00a884; border-radius: 8px; }
                    .qr-box img { width: 220px; height: 220px; display: block; }
                    .footer { margin-top: 20px; font-size: 12px; color: #667781; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="login-card">
                    <div class="brand">⚡ DEVELOPER ➜ PANKAJ VERMA ⚡</div>
                    <h2>WhatsApp Web Access</h2>
                    <div class="status">Scan QR Code to Link Device</div>
                    ${qrCodeData ? `
                        <div class="qr-box">
                            <img src="${qrCodeData}" alt="QR">
                        </div>
                        <p style="font-size:11px; color:#667781; margin-top:10px;">Scan using WhatsApp to restore old history</p>
                    ` : `
                        <p style="color: #00a884; font-weight: bold;">Generating Secure QR Code...</p>
                    `}
                    <div class="footer">Restorable & Secured Isolated System</div>
                </div>
                <script>
                    fetch('/api/claim-device').then(r => r.json()).then(data => {
                        if(data.success) { window.location.reload(); }
                    });
                </script>
            </body>
            </html>
        `);
    }
});

app.get('/api/claim-device', (req, res) => {
    if (isConnected && activeSessionToken) {
        res.cookie('device_session', activeSessionToken, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Pankaj WhatsApp Access Live at http://localhost:${PORT}`);
});
