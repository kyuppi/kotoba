import Peer from "https://esm.sh/peerjs@1.5.4";

const $ = id => document.getElementById(id);
let peer = null;
let hostConnection = null;
let isHost = false;
let roomCode = "";
let nickname = "";
let connections = new Map(); // peerId -> DataConnection
let people = new Map();      // peerId -> {name, text}
let typingTimer = null;
let intentionalClose = false;

function setStatus(message, target = "homeStatus") { $(target).textContent = message; }
function safeName(value) { return value.trim().slice(0, 20) || "ななし"; }
function showRoom() {
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomTitle").textContent = roomCode;
  render();
}
function showHome() {
  $("room").classList.add("hidden");
  $("home").classList.remove("hidden");
  $("liveInput").value = "";
  $("charCount").textContent = "0 / 500";
  $("roomCode").value = "";
}
function send(connection, data) {
  if (connection && connection.open) connection.send(data);
}
function broadcast(data, exceptId = null) {
  for (const [id, conn] of connections) if (id !== exceptId) send(conn, data);
}
function render() {
  const list = $("membersList");
  list.replaceChildren();
  const self = document.createElement("span");
  self.className = "member";
  self.textContent = `${nickname}（あなた）`;
  list.append(self);
  for (const [id, person] of people) {
    if (id === peer?.id) continue;
    const tag = document.createElement("span");
    tag.className = "member";
    tag.textContent = person.name || "ななし";
    list.append(tag);
  }
  $("memberCount").textContent = String(1 + people.size);
  const feed = $("liveFeed");
  feed.replaceChildren();
  const active = [...people.entries()].filter(([id, p]) => id !== peer?.id && p.text && p.text.trim());
  if (!active.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "ほかの人が入力すると、ここに表示されます。";
    feed.append(empty);
    return;
  }
  for (const [, person] of active) {
    const card = document.createElement("div");
    card.className = "live-card";
    const name = document.createElement("div");
    name.className = "live-name";
    name.textContent = person.name || "ななし";
    const text = document.createElement("div");
    text.className = "live-text";
    text.textContent = person.text;
    card.append(name, text);
    feed.append(card);
  }
}
function packet(type, extra = {}) { return {type, ...extra}; }

function handleHostMessage(conn, data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "typing" && typeof data.text === "string") {
    const text = data.text.slice(0, 500);
    people.set(conn.peer, {name: safeName(data.name || "ななし"), text});
    broadcast(packet("typing", {id: conn.peer, name: safeName(data.name || "ななし"), text}), conn.peer);
    render();
  } else if (data.type === "hello") {
    people.set(conn.peer, {name: safeName(data.name || "ななし"), text: ""});
    send(conn, packet("welcome", {
      hostName: nickname,
      members: [...people.entries()].map(([id, p]) => ({id, name: p.name, text: p.text}))
    }));
    broadcast(packet("member-joined", {id: conn.peer, name: safeName(data.name || "ななし")}), conn.peer);
    render();
  } else if (data.type === "leave") {
    removePerson(conn.peer);
  }
}
function removePerson(id) {
  people.delete(id);
  const conn = connections.get(id);
  if (conn) { connections.delete(id); try { conn.close(); } catch {} }
  broadcast(packet("member-left", {id}));
  render();
}
function setupHostConnection(conn) {
  connections.set(conn.peer, conn);
  conn.on("open", () => send(conn, packet("hello-ack")));
  conn.on("data", data => handleHostMessage(conn, data));
  conn.on("close", () => removePerson(conn.peer));
  conn.on("error", () => removePerson(conn.peer));
}
function setupGuestConnection(conn) {
  hostConnection = conn;
  conn.on("open", () => send(conn, packet("hello", {name: nickname})));
  conn.on("data", data => {
    if (!data || typeof data !== "object") return;
    if (data.type === "welcome") {
      people.clear();
      people.set("host", {name: data.hostName || "部屋の作成者", text: ""});
      for (const p of (data.members || [])) people.set(p.id, {name: p.name, text: p.text || ""});
      render();
      setStatus("部屋に接続しました。", "roomStatus");
    } else if (data.type === "typing") {
      people.set(data.id, {name: data.name, text: data.text});
      render();
    } else if (data.type === "member-joined") {
      people.set(data.id, {name: data.name, text: ""});
      render();
    } else if (data.type === "member-left") {
      people.delete(data.id);
      render();
    } else if (data.type === "host-typing") {
      people.set("host", {name: data.name || "部屋の作成者", text: data.text || ""});
      render();
    } else if (data.type === "host-left") {
      setStatus("部屋の作成者との接続が切れました。部屋は終了しています。", "roomStatus");
      $("liveInput").disabled = true;
    }
  });
  conn.on("close", () => {
    setStatus("接続が切れました。部屋が終了した可能性があります。", "roomStatus");
    $("liveInput").disabled = true;
  });
  conn.on("error", () => setStatus("通信エラーが発生しました。", "roomStatus"));
}
async function createRoom() {
  try {
    $("createBtn").disabled = true;
    nickname = safeName($("nickname").value);
    isHost = true;
    setStatus("部屋を準備しています…");
    peer = new Peer();
    peer.on("open", id => {
      roomCode = id;
      people.clear();
      $("liveInput").disabled = false;
      showRoom();
      setStatus("部屋を作成しました。コードを友達に共有してください。", "roomStatus");
    });
    peer.on("connection", setupHostConnection);
    peer.on("error", err => {
      setStatus("接続エラー：" + peerError(err));
      $("createBtn").disabled = false;
    });
    peer.on("disconnected", () => setStatus("通信サーバーとの接続が切れました。", "roomStatus"));
  } catch (e) {
    setStatus("部屋を作成できませんでした：" + e.message);
    $("createBtn").disabled = false;
  }
}
function peerError(err) {
  const messages = {
    "peer-unavailable": "部屋が見つかりません。コードを確認してください。",
    "network": "ネットワークに接続できません。通信環境を確認してください。",
    "server-error": "接続サービスが一時的に利用できません。",
    "unavailable-id": "部屋コードが使用できません。もう一度作成してください。"
  };
  return messages[err.type] || err.message || "時間をおいて再度お試しください。";
}
async function joinRoom() {
  try {
    $("joinBtn").disabled = true;
    nickname = safeName($("nickname").value);
    roomCode = $("roomCode").value.trim();
    if (!roomCode || roomCode.length < 5) throw new Error("部屋コードを正しく入力してください。");
    isHost = false;
    setStatus("部屋に接続しています…");
    peer = new Peer();
    peer.on("open", () => {
      const conn = peer.connect(roomCode, {reliable: true, serialization: "json"});
      setupGuestConnection(conn);
      conn.on("error", err => setStatus(peerError(err), "homeStatus"));
      conn.on("open", () => {
        $("liveInput").disabled = false;
        showRoom();
        setStatus("接続しています…", "roomStatus");
      });
    });
    peer.on("error", err => {
      setStatus(peerError(err));
      $("joinBtn").disabled = false;
    });
  } catch (e) {
    setStatus(e.message);
    $("joinBtn").disabled = false;
  }
}
function publishText(text) {
  const value = text.slice(0, 500);
  if (isHost) {
    broadcast(packet("host-typing", {name: nickname, text: value}));
  } else {
    send(hostConnection, packet("typing", {name: nickname, text: value}));
  }
}
async function leaveRoom() {
  intentionalClose = true;
  clearTimeout(typingTimer);
  if (isHost) {
    broadcast(packet("host-left"));
  } else {
    send(hostConnection, packet("leave"));
  }
  for (const conn of connections.values()) { try { conn.close(); } catch {} }
  connections.clear();
  if (hostConnection) { try { hostConnection.close(); } catch {} }
  if (peer) { try { peer.destroy(); } catch {} }
  peer = null; hostConnection = null; roomCode = ""; people.clear(); isHost = false;
  $("liveInput").disabled = false;
  $("createBtn").disabled = false; $("joinBtn").disabled = false;
  showHome();
  setStatus("退出しました。");
  intentionalClose = false;
}
$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", joinRoom);
$("leaveBtn").addEventListener("click", leaveRoom);
$("clearBtn").addEventListener("click", () => {
  $("liveInput").value = "";
  $("charCount").textContent = "0 / 500";
  publishText("");
});
$("liveInput").addEventListener("input", () => {
  const value = $("liveInput").value;
  $("charCount").textContent = `${value.length} / 500`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => publishText(value), 70);
});
$("copyCodeBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    setStatus("部屋コードをコピーしました。", "roomStatus");
  } catch {
    setStatus("コピーできません。部屋コードを長押ししてコピーしてください。", "roomStatus");
  }
});
window.addEventListener("beforeunload", () => {
  if (peer) peer.destroy();
});
