const request = require('request');
const fs = require('fs');
const url = require('url');
const ejs = require('ejs');
const http = require('http');
const WebSocket = require('ws');
const log4js = require("log4js");
const moment = require('moment');
const NodeCache = require('node-cache');
const { exec } = require('child_process');
EventSource = require('eventsource');
const ReconnectingEventSource = require('reconnecting-eventsource').default;

// Logging configure
log4js.configure({
    appenders: { everything: { type: 'file', filename: 'server.log' } },
    categories: { default: { appenders: [ 'everything' ], level: 'debug' } }
});
const logger = log4js.getLogger();

process.on('uncaughtException', (err, origin) => {
    logger.error(err);
    logger.error(origin);
});

const exp = require('./service/storage');

var content = fs.readFileSync('public/index.html', 'utf-8');
var compiled = ejs.compile(content);

const swmt = exp.swmt;
const lt300 = exp.lt300;
const groupFilt = exp.groupFilt;
const siteGroups = exp.siteGroups;
const userAgent = exp.userAgent;
const namespaces = exp.namespaces;
const customSandBoxes = exp.customSandBoxes;

const cacheCVN = new NodeCache({ "stdTTL": 18000 }); // 5 h
const token = fs.readFileSync('service/token.txt', 'utf8');

var source;
var errors = 0;
var globals = [];
var storage = [];
var generalList = [];
var sandboxlist = [];
var ORESList = null;
var eventPerMin = "-";
var eventPerMinPrepare = 0;
var upTimeWS = moment().unix();
var upTimeSSE = moment().unix();
const port = +(process.env.PORT || 9030);
var admins = ["Iluvatar", "Ajbura", "1997kB"];

// The Talk / Websocket

const server = http.createServer((req, res) => {
    if (req.url === "/git-pull" && typeof req.headers["x-github-event"] !== "undefined") {
        execute("git pull").then(function(response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            compiledScript = ejs.compile(response); res.end(compiledScript({}));
        }).catch(function(response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            compiledScript = ejs.compile(response); res.end(compiledScript({}));
        });
    } else if (req.url === "/restart" && typeof req.headers.auth !== "undefined" && req.headers.auth === token) {
        execute("sh service/restart.sh").then(function(response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            compiledScript = ejs.compile(response); res.end(compiledScript({}));
        }).catch(function(response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            compiledScript = ejs.compile(response); res.end(compiledScript({}));
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const streamClients = getClients(); const garbage = getGarbage(); const cached = getCached();
        const memory = Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100;
        const upTimeWSSend = new Date((moment().unix() - upTimeWS) * 1000).toISOString().substr(11, 8);
        const upTimeSSESend = new Date((moment().unix() - upTimeSSE) * 1000).toISOString().substr(11, 8);
        res.end(compiled({clients: streamClients, garbage: garbage, cache: cached, memory: memory, errors: errors,
            upTimeWS: upTimeWSSend, upTimeSSE: upTimeSSESend, eventPerMin: eventPerMin, wikis: generalList.length,
            globals: globals.length}));
    }
});
server.listen(port, () => 'Server up');

function execute(comm) {
    return new Promise(function(resolve, reject){
        exec(comm, function(err, stdout, stderr){
            if (typeof error !== "undefined") {
                reject(JSON.stringify('{"result": "error", "info": fatal error'));
                return;
            }
            if (typeof stderr !== "undefined"){
                if (comm === "git pull") logger.debug("Execute (git) error: " + stderr);
                reject(JSON.stringify('{"result": "error", "info": ' + stderr));
                return;
            }
            resolve(JSON.stringify('{"result": "success", "info": ' + stdout));
        })
    })
}

function getClients () {
    if (typeof wss !== "undefined")
        if (wss.hasOwnProperty("clients"))
            return wss.clients.size;
    return null;
}

function getCached() {
    return (typeof cacheCVN !== "undefined") ? cacheCVN.getStats().keys : null;
}

function getGarbage () {
    let i = 0;
    if (typeof storage !== "undefined") {
        Object.keys(storage).forEach(function(key) {
            const l = (!storage[key].hasOwnProperty(0)) ? storage[key] : storage[key][0];
            if (l.hasOwnProperty("time"))
                if (l.time <= (Date.now() - 1000 * 60))
                    i++;
        });
        return i;
    } else return null;
}

const wss = new WebSocket.Server({ noServer: true, verifyClient(info, done) {
        upTimeWS = moment().unix();
        const nickName = url.parse(info.req.url, true).query.name;
        const userToken = url.parse(info.req.url, true).query.token;
        try {
            request({
                method: "POST", uri: "https://swviewer.toolforge.org/php/authTalk.php", headers: {"User-Agent": userAgent},
                form: { serverToken: token, userToken: userToken, username: nickName }
            }, function (error, response, body) {
                if (!body || response.statusCode !== 200 || error) return done(false, 403, "Error of auth; bad request");
                return (JSON.parse(body).auth !== "true") ? done(false, 403, "Token is not valid") : done(true);
            });
        }
        catch (e) {
            return done(false, 403, "Error of auth; Maybe no connect");
        }
    }
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', function(ws, req) {
    ws.nickName = url.parse('https://swviewer-service.toolforge.org:9030' + req.url, true).query.name;
    ws.timeConnected = new Date().toLocaleTimeString("en-GB");
    ws.preset = url.parse('https://swviewer-service.toolforge.org:9030' + req.url, true).query.preset;
    ws.isAlive = true;
    ws.pause = false;
    getParams(ws).then(function(res) {
        if (res === false || res === undefined) { ws.terminate(); return; }
        ws.filt = res;
        getGeneralList();
        if (wss.clients.size === 1) SSEStart();
        wss.clients.forEach(function(client) {
            if (client.readyState === WebSocket.OPEN && client !== ws)
                client.send(JSON.stringify({"type": "connected", "nickname": ws.nickName}));
        });

        if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({"type": "hello", "clients": getUsersList()}));

        ws.on('pong', function() {
            ws.isAlive = true;
        });

        ws.on('message', function(message) {
            const msg = JSON.parse(message);

            if (msg.type === 'message') {
                if (msg.text.match(/^\s*\//) && admins.includes(ws.nickName)) {
                    let comm = msg.text.match(/^\s*\/(.*?)(\s|$)/);
                    if (comm && comm.hasOwnProperty(1)) {

                        if (comm[1] === "kik") {
                            let kik_name = msg.text.match(/^\s*\/(.*?)\s+(.*)/);
                            if (kik_name && kik_name.hasOwnProperty(2)) {
                                kik_name = kik_name[2].replace(/^\s*/, "")
                                if (kik_name !== "")
                                    wss.clients.forEach(function(client) {
                                        if (client.nickName === kik_name) client.send(JSON.stringify({"type": "command", "nickname": ws.nickName, "text": "/kik"}));
                                    });
                            }
                        }
                        if (comm[1] === "cache") {
                            wss.clients.forEach(function(client) {
                                client.send(JSON.stringify({"type": "command", "nickname": ws.nickName, "text": "/cache"}));
                            });
                        }

                    }
                } else {
                    wss.clients.forEach(function(client) {
                        if (client.readyState === WebSocket.OPEN)
                            client.send(JSON.stringify({"type": "message", "nickname": ws.nickName, "text": msg.text}));
                    });
                    request({
                        method: "POST", uri: "https://swviewer.toolforge.org/php/talkHistory.php", headers: {"User-Agent": userAgent},
                        form: { action: "save", serverToken: token, username: ws.nickName, text: msg.text }
                    });
                }
            }

            if (msg.type === 'synch') {
                wss.clients.forEach(function(client) {
                    if (client.readyState === WebSocket.OPEN && client !== ws)
                        client.send(JSON.stringify({"type": "synch", "wiki": msg.wiki, "nickname": msg.nickname, "vandal": msg.vandal, "page": msg.page}));
                });
            }

            if (msg.type === 'pause') {
                ws.pause = (!ws.pause);
                getGeneralList();
                ws.send(JSON.stringify({"type": "pause", "state": ws.pause}));
            }
        });

        ws.on('close', function() {
            wss.clients.forEach(function(client) {
                if (client.readyState === WebSocket.OPEN)
                    client.send(JSON.stringify({"type": "disconnected", "clients": getUsersList(), "client": ws.nickName}));
            });
            if (wss.clients.size === 0) { logger.debug("Stream closed (1)"); if (typeof source !== "undefined") source.close(); } else getGeneralList();
        });
    }).catch(function(e) {
        logger.debug("getParams promise error");
        logger.debug(e);
    });
});

setInterval(function ping() {
    wss.clients.forEach(function(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(function() {});
    });
}, 2500000); // 41.6 min

function getUsersList() {
    let usersList = [];
    wss.clients.forEach(function(ws) {
        if (!usersList.includes(ws.nickName))
            usersList.push(ws.nickName);
    });
    return usersList.join();
}

/*
SSE proxy
*/

request('https://ores.wikimedia.org/v3/scores', { json: true, headers: { "User-Agent": userAgent } }, (err, res) => {
    if (err) return false;
    ORESList = res.body;
});

getSandboxes();
getGlobals();

setInterval(function() {
    try {
        getSandboxes();
        getGlobals();
    } catch(err) {
        logger.debug("Updating lists error: " + err);
    }
}, 86400000); // 24 h

function getSandboxes() {
    sandboxlist = [];
    request('https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q3938&props=sitelinks/urls&format=json&utf8=1', { json: true, headers: { "User-Agent": userAgent } }, (err, res) => {
        if (err) return;
        let sandbox = res.body;
        for(const sb in sandbox.entities.Q3938.sitelinks) {
            if (sandbox.entities.Q3938.sitelinks.hasOwnProperty(sb))
                sandboxlist[sandbox.entities.Q3938.sitelinks[sb].site] = sandbox.entities.Q3938.sitelinks[sb].title;
        }
        Object.keys(customSandBoxes).forEach(element => {
            customSandBoxes[element].forEach(element2 => {
                sandboxlist[element] = (sandboxlist.hasOwnProperty(element)) ? sandboxlist[element] + "," + element2 : element2;
            });
        });
    });
}

function getGlobals() {
    request('https://swviewer.toolforge.org/php/getGlobals.php?token_proxy=' + token, { json: false, headers: { "User-Agent": userAgent } }, (err, res) => {
        if (err) return false;
        globals = res.body.slice(0, -1).split(",");
    });
}

function SSEStart() {
    source = new ReconnectingEventSource('https://stream.wikimedia.org/v2/stream/recentchange,revision-create');
    source.onmessage = function(e) {
        try {
            if (wss.clients.size === 0) { logger.debug("Stream closed (2)"); source.close(); return; }
            if (e.type !== "message") return;
            e = JSON.parse(e.data);
            if (!streamFilter(e)) return;
            e.time = Date.now();
            const uniqWiki = (e.hasOwnProperty("wiki")) ? e.wiki : e.database;
            const uniqRev = (e.hasOwnProperty("rev_id")) ? e.rev_id : e.revision.new;
            const uniqID = String(e.meta.request_id) + String(uniqWiki) + String(uniqRev);
            if (!storage[uniqID]) { storage[uniqID] = [e]; return; }
            if (checkStreamExist(storage[uniqID], e.meta.stream)) return;
            storage[uniqID].push(e);
            let result = mergeList(normalizeArray(storage[uniqID][0]), normalizeArray(storage[uniqID][1]));
            if (!result.performer.hasOwnProperty("user_text")) { errors++; return; }
            checkCVN(result.performer.user_text, result.performer.user_is_anon).then(function(res) {
                if (res === undefined) res = true;
                if (res === false) { delete storage[uniqID]; return false; }
                getWikidataTitle(result).then(function(res) {
                    if (res === undefined) res = null;
                    result.wikidata_title = res;
                    eventPerMinPrepare++;
                    getORES(result.wiki, result.new_id, getModel(ORESList, result.wiki)).then(function(res) {
                        if (res === undefined || res === false) res = null;
                        result.ORES = res;
                        wss.clients.forEach(function (ws) {
                            if (ws.readyState === WebSocket.OPEN && ws.pause !== true && ws.hasOwnProperty("filt"))
                                customFilter(result, ws.filt, ws.nickName, ws.timeConnected).then(function(res) {
                                    if (res !== undefined && res !== null && res)
                                        ws.send(JSON.stringify({"type": "edit", "data": result}));
                                });
                        });
                    });
                    delete storage[uniqID];
                });
            });
        } catch(err) {
            logger.debug("global error: " + err);
        }
    };
    source.onopen = function () {
        upTimeSSE = moment().unix();
        logger.debug("Stream connected");
    };
    source.onerror = function (err) {
        logger.debug("Stream disconnected (error):");
        logger.debug(err);
    };
}

function getModel(olist, wiki){
    if (olist === null) return false;
    if (Object.keys(olist).length === 0) return false;
    if (Object.keys(olist).find(oresWiki => oresWiki === wiki) === undefined) return false;
    if (olist[wiki].models.damaging !== undefined) return 'damaging';
    else if (olist[wiki].models.reverted !== undefined) return 'reverted';
    else return false;
}

async function getORES(wiki, new_id, model) {
    return new Promise(resolve => {
        if (model === false) { resolve(false); return; }
        request("https://ores.wikimedia.org/v3/scores/" + String(wiki) + "/" + String(new_id) + "/" + String(model), {
            json: true, headers: {"User-Agent": userAgent}
        }, (err, res) => {
            if (err) { resolve(false); return; }
            if (res.body.hasOwnProperty("error")) { resolve(false); return; }
            if (res.body[wiki] === undefined) { resolve(false); return; }
            if (!res.body[wiki].hasOwnProperty("scores")) { resolve(false); return; }
            if (res.body[wiki].scores[new_id] === undefined) { resolve(false); return; }
            if (res.body[wiki].scores[new_id][model] === undefined) { resolve(false); return; }
            if (res.body[wiki].scores[new_id][model].error !== undefined) { resolve(false); return; }
            if (res.body[wiki].scores[new_id][model].score === undefined) { resolve(false); return; }
            const damage = res.body[wiki].scores[new_id][model].score.probability.true;
            const damagePer = parseInt(damage * 100);
            resolve({score: damagePer, color: `hsl(0, ${damagePer}%, 56%)`});
        });
    }).catch(function(err) {
        logger.debug("getORES promise error: " + err);
    });
}

function checkStreamExist(exist, streamName) {
    let check = false;
    exist.forEach(function (k) {
        if (k.meta.stream === streamName) check = true;
    });
    return check;
}

function mergeList(arr1, arr2, arr3 = null) {
    for(const key in arr2) {
        if (arr2.hasOwnProperty(key))
            if ((arr2[key] !== "") && (arr2[key] !== null) && (typeof arr2[key] !== "object" || Object.keys(arr2[key]).length > 0))
                arr1[key] = arr2[key];
    }
    if (arr3 !== null) {
        for(const key2 in arr3) {
            if (arr3.hasOwnProperty(key2))
                if ((arr3[key2] !== "") && (arr3[key2] !== null) && (typeof arr3[key2] !== "object" || Object.keys(arr3[key2]).length > 0))
                    arr1[key2] = arr3[key2];
        }
    }
    return arr1;
}

function streamFilter(e) {
    if ((e.hasOwnProperty("wiki") && !generalList.includes(e.wiki)) || (e.hasOwnProperty("database") && !generalList.includes(e.database))) return false; // general wiki list
    if (e.meta.stream === "mediawiki.revision-create" && (e.page_namespace === 6 && !e.hasOwnProperty("rev_parent_id"))) return false; // upload files
    if (e.meta.stream === "mediawiki.revision-create" && e.database === "wikidatawiki" && e.is_redirect === true) return false; // redirects on wikidata
    if (e.meta.stream === "mediawiki.recentchange" && (e.type !== "edit" && e.type !== "new")) return false; // cats, uploads, logs
    if ((e.hasOwnProperty("title") && sandboxlist.includes(e.title)) || (e.hasOwnProperty("page_title") && sandboxlist.includes(e.page_title))) return false; // sandboxes
    if ((e.hasOwnProperty("user") && globals.includes(e.user)) || (e.hasOwnProperty("performer") && e.performer.hasOwnProperty("user_text") && globals.includes(e.performer.user_text))) return false; // global users
    if (e.meta.stream === "mediawiki.revision-create" && (e.hasOwnProperty("performer") && e.performer.hasOwnProperty("user_is_bot") && e.performer.user_is_bot === true)) return false; // bot
    if (e.meta.stream === "mediawiki.recentchange" && (e.hasOwnProperty("bot") && e.bot === true)) return false; // mark as bot edit
    if (e.meta.stream === "mediawiki.recentchange" && e.patrolled === true) return false; // patrolled
    if (e.meta.stream === "mediawiki.revision-create" && (e.rev_is_revert === true && e.rev_revert_details.rev_revert_method === "rollback")) return false; // rollback
    if (e.meta.stream === "mediawiki.revision-create" && (Object.values(e.performer.user_groups).some(v => groupFilt.indexOf(v) !== -1) === true)) return false; // groups
    return true;
}

function customFilter(e, filter, nick, timeConnected) {
    return new Promise(resolve => {
        if (typeof filter === undefined) { resolve(false); logger.debug("Filter is undefined"); return; }
        if (e.performer.user_text === nick) { resolve(false); return; }
        if (filter.anons === 0 && e.performer.user_is_anon === true) { resolve(false); return; }
        if (filter.registered === 0 && e.performer.user_is_anon === false) { resolve(false); return; }
        if (filter.new === 0 && e.is_new === true) { resolve(false); return; }
        if (filter.onlynew === 1 && e.is_new === false) { resolve(false); return; }
        if (e.performer.user_is_anon === false && e.performer.user_registration_dt === null && filter.edits <= e.performer.user_edit_count) { resolve(false); return; }
        if (!filter.namespaces.split(',').includes(e.namespace.toString()) && filter.namespaces.length !== 0) { resolve(false); return; }
        if (filter.wikiwhitelist.split(',').includes(e.wiki)) { resolve(false); return; }
        if (filter.userwhitelist.split(',').includes(e.performer.user_text)) { resolve(false); return; }
        if (e.performer.user_is_anon === false && e.performer.user_registration_dt !== null) {
            const d = new Date();
            const dateDiff = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) - Date.parse(e.performer.user_registration_dt)) / 1000 / 60 / 60 / 24;
            if (filter.edits <= e.performer.user_edit_count && dateDiff >= filter.days) { resolve(false); return; }
        }
        if (typeof sandboxlist[e.wiki] !== "undefined" && sandboxlist[e.wiki].split(',').includes(e.title)) { resolve(false); return; }
        if (e.ORES !== null && filter.ores !== 0 && filter.ores > e.ORES.score) { resolve(false); return; }
        resolve((filter.wikis.split(',').includes(e.wiki)) ||
            (filter.local_wikis.split(',').includes(e.wiki) && filter.isGlobal === false) ||
            (swmt.includes(e.wiki) && filter.swmt === 1 && (filter.isGlobal === true || filter.isGlobalModeAccess === true)) ||
            (filter.langWikis.includes(e.wiki) && (filter.isGlobal === true || filter.isGlobalModeAccess === true)) ||
            (lt300.includes(e.wiki) && filter.lt300 === 1 && (filter.isGlobal === true || filter.isGlobalModeAccess === true)));

    }).catch(function(err) {
        logger.debug("customFilter promise error: " + err);
        logger.debug("customFilter promise error (nickname): " + nick);
        logger.debug("customFilter promise error (time connected): " + timeConnected);
        logger.debug(filter);
    });
}

async function checkCVN(username, is_anon) {
    return new Promise(resolve => {
        if (is_anon === true) resolve(true);
        else if (typeof cacheCVN.get(String(username)) !== "undefined") resolve(cacheCVN.get(String(username)));
        else
            request("https://cvn.wmflabs.org/api.php?users=" + encodeURIComponent(username).replace(/'/g, '%27'), { json: true, headers: { "User-Agent": userAgent } }, (err, res) => {
                if (err) { resolve(true); return; }
                (res.body.hasOwnProperty("users") && res.body.users.hasOwnProperty(username) && res.body.users[username].hasOwnProperty("type") && res.body.users[username].type === "whitelist") ? resolve(false) : resolve(true);
                (res.body.hasOwnProperty("users") && res.body.users.hasOwnProperty(username) && res.body.users[username].hasOwnProperty("type") && res.body.users[username].type === "whitelist") ? cacheCVN.set(String(username), false) : cacheCVN.set(String(username), true);
            });
    }).catch(function(err) {
        logger.debug("checkCVN promise error: " + err);
    });
}

// Get labels for Wikidata elements. Instead "Q2735363" we will see title of article
function getWikidataTitle (e) {
    return new Promise(resolve => {
        if (e.wiki === "wikidatawiki" && (e.namespace === 120 || e.namespace === 0) && (e.title.search(/^P\d*?$/gm) !== -1 || e.title.search(/^Q\d*?$/gm) !== -1)) {
            const urlWD = "https://www.wikidata.org/w/api.php?action=wbgetentities&ids=" + encodeURIComponent(e.title) + "&props=labels&languages=en&format=json&utf8=1";
            request(urlWD, { json: true, headers: { "User-Agent": userAgent } }, (err, res) => {
                if (err) { resolve(null); return; }
                if ((res.body.hasOwnProperty("entities")) && (res.body.entities.hasOwnProperty(e.title)) &&
                    (res.body.entities[e.title].hasOwnProperty("labels")) &&
                    (res.body.entities[e.title].labels.hasOwnProperty("en")) &&
                    (res.body.entities[e.title].labels.en.hasOwnProperty("value")) &&
                    (res.body.entities[e.title].labels.en.value !== null || res.body.entities[e.title].labels.en.value !== ""))
                    resolve(res.body.entities[e.title].labels.en.value);
                else resolve(null);
            });
        } else resolve(null);
    }).catch(function(err) {
        logger.debug("getWikidataTitle promise error: " + err);
    });
}

function normalizeArray(e) {
    let normArray = {
        "wiki": "", "domain": "", "uri": "", "title": "", "wikidata_title": null, "id": "", "namespace": "",
        "namespace_name": null, "new_id": "",  "old_id": null, "new_len": "", "old_len": null, "is_new": false,
        "is_minor": "",  "is_redirect": "", "is_revert": false, "comment": null, "performer": {}, "ORES": null,
        "timestamp": "" };
    normArray.wiki = (e.hasOwnProperty("database")) ? e.database : e.wiki;
    normArray.domain = e.meta.domain;
    normArray.uri = e.meta.uri;
    normArray.id = (e.hasOwnProperty("page_id")) ? e.page_id : e.id;
    normArray.title = (e.hasOwnProperty("page_title")) ? e.page_title : e.title;
    normArray.namespace = (e.hasOwnProperty("page_namespace")) ? e.page_namespace : e.namespace;
    normArray.new_id = (e.hasOwnProperty("rev_id")) ? e.rev_id : e.revision.new;
    normArray.timestamp = (e.hasOwnProperty("rev_timestamp")) ? e.rev_timestamp : e.timestamp;
    normArray.new_len = (e.hasOwnProperty("rev_len")) ? e.rev_len : e.length.new;
    normArray.is_redirect = (e.hasOwnProperty("page_is_redirect")) ? e.page_is_redirect : normArray.is_redirect;
    normArray.comment = (e.hasOwnProperty("comment")) ? e.comment : normArray.comment;
    normArray.is_revert = (e.hasOwnProperty("rev_is_revert")) ? e.rev_is_revert : normArray.is_revert;
    normArray.performer = (e.hasOwnProperty("performer")) ? e.performer : normArray.performer;
    normArray.is_minor = (e.hasOwnProperty("rev_minor_edit")) ? e.rev_minor_edit : e.minor;
    if (e.hasOwnProperty("performer"))
        e.performer.user_is_anon = (Object.values(e.performer.user_groups).indexOf("user") === -1);
    if ((!e.hasOwnProperty("revision") && !e.hasOwnProperty("rev_parent_id")) || (e.hasOwnProperty("revision") && !e.revision.hasOwnProperty("old")))
        normArray.is_new = true;
    else normArray.old_id = (e.hasOwnProperty("rev_parent_id")) ? e.rev_parent_id : e.revision.old;
    if (e.meta.stream === "mediawiki.recentchange")
        normArray.old_len = (e.length.hasOwnProperty("old")) ? e.length.old : normArray.old_len;
    if (e.hasOwnProperty("page_namespace")) {
        normArray.namespace_name = (e.page_namespace >= 0 && e.page_namespace <= 15) ? namespaces[e.page_namespace]
            : '<span style="color: brown;">Non-canon (' + e.page_namespace + ')</span>';
        if (e.database === "wikidatawiki") {
            if (e.page_namespace === 146) normArray.namespace_name = "Lexeme";
            if (e.page_namespace === 122) normArray.namespace_name = "Query";
            if (e.page_namespace === 120)  if (normArray.title.search(/^P\d*?$/gm) !== -1) normArray.namespace_name = "Property";
        }
        if (e.database === "enwiki") {
            if (e.page_namespace === 118) normArray.namespace_name = "Draft";
            if (e.page_namespace === 119) normArray.namespace_name = "Draft talk";
        }
        if (e.page_namespace === 1198) normArray.namespace_name = "Translations";
        if (e.page_namespace === 1199) normArray.namespace_name = "Translations talk";

    }

    return normArray;
}

function getParams(w) {
    return new Promise(resolve => {
        let paramsurl = 'https://swviewer.toolforge.org/php/getFilt.php?preset_name=' + encodeURIComponent(w.preset).replace(/'/g, '%27') +
            '&token_proxy=' + token + '&username=' + encodeURIComponent(w.nickName).replace(/'/g, '%27');
        request(paramsurl, { json: true, headers: { "User-Agent": userAgent } }, (err, res) => {
            if (err) { resolve(false); return; }
            if (typeof res == "undefined" || res === null || !res.hasOwnProperty("body")) { logger.debug("Get params error: " + paramsurl.replace(token, "")); resolve(false); return;}
            if (res.body.hasOwnProperty("error")) { resolve(false); return; }

            let filter = [];
            filter.swmt =  (parseInt(res.body.swmt) === 1 || parseInt(res.body.swmt) === 2) ? 1 : 0;
            filter.lt300 = (parseInt(res.body.users) === 1 || parseInt(res.body.users) === 2) ? 1 : 0;
            filter.edits = parseInt(res.body.editcount);
            filter.days = parseInt(res.body.regdays);
            filter.registered = parseInt(res.body.registered);
            filter.anons = parseInt(res.body.onlyanons);
            filter.new = parseInt(res.body.new);
            filter.onlynew = parseInt(res.body.onlynew);
            filter.ores = parseInt(res.body.oresFilter);
            filter.namespaces = (res.body.namespaces !== null) ? res.body.namespaces : "";
            filter.wikiwhitelist = (res.body.wlprojects !== null) ? res.body.wlprojects : "";
            filter.userwhitelist = (res.body.wlusers !== null) ? res.body.wlusers : "";
            filter.wikis = (res.body.blprojects !== null) ? res.body.blprojects : "";
            filter.local_wikis = (res.body.local_wikis !== null) ? res.body.local_wikis : "";
            filter.isGlobalModeAccess = (parseInt(res.body.isGlobalModeAccess) === 1);
            filter.isGlobal = (parseInt(res.body.isGlobal) === 1);
            filter.langWikis = [];
            if (res.body.wikilangs !== null && res.body.wikilangs !== "") {
                let l = res.body.wikilangs.split(",");
                l.forEach(function (el) { siteGroups.forEach(function(el2) {
                    if (el !== "") {
                        filter.langWikis.push(el + el2);
                        if (el === "en") {
                            filter.langWikis.push("metawiki");
                            filter.langWikis.push("wikidatawiki"); filter.langWikis.push("commonswiki");
                            filter.langWikis.push("mediawikiwiki"); filter.langWikis.push("incubatorwiki");
                            filter.langWikis.push("wikimaniawiki"); filter.langWikis.push("foundationwiki");

                        }
                    }
                }); });
            }

            resolve(filter);
        });
    }).catch(function(err) {
        logger.debug("getParams promise error: " + err);
    });
}

function getGeneralList() {
    let generalListPrepare = [];
    let swmtCheck = false; let lt300Check = false;

    wss.clients.forEach(function(ws) {
        if (ws.pause !== true && ws.hasOwnProperty("filt")) {
            if (ws.filt.swmt === 1 && (ws.filt.isGlobal === true || ws.filt.isGlobalModeAccess === true))
                swmtCheck = true;
            if (ws.filt.lt300 === 1 && (ws.filt.isGlobal === true || ws.filt.isGlobalModeAccess === true))
                lt300Check = true;

            ws.filt.wikis.split(',').forEach(function (el) {
                if (!generalListPrepare.includes(el) && !ws.filt.wikiwhitelist.split(',').includes(el)) generalListPrepare.push(el);
            });

            ws.filt.langWikis.forEach(function (el) {
                if (!generalListPrepare.includes(el) && !ws.filt.wikiwhitelist.split(',').includes(el)) generalListPrepare.push(el);
            });

            if (ws.filt.isGlobal === false)
                ws.filt.local_wikis.split(',').forEach(function (el) {
                    if (!generalListPrepare.includes(el) && !ws.filt.wikiwhitelist.split(',').includes(el)) generalListPrepare.push(el);
                });
        }
    });
    if (swmtCheck === true)
        swmt.forEach(function (el) {
            if (!generalListPrepare.includes(el)) generalListPrepare.push(el);
        });
    if (lt300Check === true)
        lt300.forEach(function (el) {
            if (!generalListPrepare.includes(el)) generalListPrepare.push(el);
        });
    generalList = generalListPrepare;
}

setInterval(function() {
    Object.keys(storage).forEach(function(key) {
        const l = (!storage[key].hasOwnProperty(0)) ? storage[key] : storage[key][0];
        if (l.hasOwnProperty("time"))
            if (l.time <= (Date.now() - 1000 * 60 * 3))
                delete storage[key];
    });
}, 5000);

setInterval(function() {
    eventPerMin = eventPerMinPrepare;
    eventPerMinPrepare = 0;
}, 60000);

function streamCheck() {
    if (wss.clients.size === 0 && source.readyState === 2) {
        logger.debug("StreamCheck run");
        SSEStart();
    }
}
setInterval(streamCheck, 20000);

function CheckClients() {
    logger.debug("Clients: " + wss.clients.size)
}
setInterval(CheckClients, 30000);