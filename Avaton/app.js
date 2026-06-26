const DEFAULT_PASSWORD = "SCOAW2899";
const PASSWORD_HASH_KEY = "avaton-password-hash";
const PASSWORD_SALT_KEY = "avaton-password-salt";
const PASSWORD_HINT_KEY = "avaton-password-hint";
const DB_NAME = "avaton-vault";
const DB_VERSION = 7;
const STORE_NAME = "scripts";
const FILE_STORE_NAME = "files";
const CHUNK_STORE_NAME = "fileChunks";
const FOLDER_STORE_NAME = "folders";
const CELL_STORE_NAME = "cells";
const STICKY_STORE_NAME = "stickyNotes";
const SETTINGS_STORE_NAME = "settings";
const DISK_HANDLE_KEY = "diskVaultHandle";
const CHUNK_SIZE = 4 * 1024 * 1024;
const DISK_CHUNK_SIZE = 16 * 1024 * 1024;
const BACKUP_MAGIC = "AVATON3\n";
const BACKUP_COMPLETE_MARKER = "\nAVATON-BACKUP-COMPLETE\n";
const COLORS = ["#7559e8", "#e76882", "#e39b47", "#43a899", "#4d83d1", "#a45fc2"];

const state = {
  scripts: [],
  folders: [],
  cells: { id: "main", activeSheetId: null, sheets: [] },
  stickyNotes: [],
  songs: [],
  diskVaultHandle: null,
  diskAttachmentsHandle: null,
  rememberedDiskVaultHandle: null,
  activeCell: { row: 0, column: 0 },
  currentScriptId: null,
  currentFolderId: null,
  pendingParentId: null,
  chosenColor: COLORS[0],
  calendarYear: 2026,
  calendarMonth: new Date().getFullYear() === 2026 ? new Date().getMonth() : 0,
  selectedDate: null,
  search: "",
  db: null
};
const transferState = { cancelled: false, mode: null, startedAt: 0 };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clearImportInput = () => {
  const input = $("#importInput");
  if (input) input.value = "";
};
const iconFolder = `<svg viewBox="0 0 24 24"><path d="M4 4h6l2 2h8v14H4Z"/><path d="M8 11h8M8 15h6"/></svg>`;
const iconFile = `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/></svg>`;

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function derivePasswordHash(password, salt) {
  if (!crypto.subtle) return bytesToBase64(new TextEncoder().encode(`${salt}:${password}`));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

async function initializePassword() {
  let saltValue = localStorage.getItem(PASSWORD_SALT_KEY);
  let hash = localStorage.getItem(PASSWORD_HASH_KEY);
  if (!saltValue || !hash) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltValue = bytesToBase64(salt);
    hash = await derivePasswordHash(DEFAULT_PASSWORD, salt);
    localStorage.setItem(PASSWORD_SALT_KEY, saltValue);
    localStorage.setItem(PASSWORD_HASH_KEY, hash);
  }
  renderPasswordHint();
}

async function verifyPassword(password) {
  const saltValue = localStorage.getItem(PASSWORD_SALT_KEY);
  const expected = localStorage.getItem(PASSWORD_HASH_KEY);
  if (!saltValue || !expected) return password === DEFAULT_PASSWORD;
  return await derivePasswordHash(password, base64ToBytes(saltValue)) === expected;
}

async function savePassword(password, hint) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(PASSWORD_SALT_KEY, bytesToBase64(salt));
  localStorage.setItem(PASSWORD_HASH_KEY, await derivePasswordHash(password, salt));
  if (hint.trim()) localStorage.setItem(PASSWORD_HINT_KEY, hint.trim());
  else localStorage.removeItem(PASSWORD_HINT_KEY);
  renderPasswordHint();
}

function renderPasswordHint() {
  const hint = localStorage.getItem(PASSWORD_HINT_KEY);
  $("#showPasswordHint").classList.toggle("hidden", !hint);
  $("#passwordHint").textContent = hint ? `Hint: ${hint}` : "";
  $("#passwordHint").classList.add("hidden");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(FILE_STORE_NAME)) db.createObjectStore(FILE_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) db.createObjectStore(CHUNK_STORE_NAME, { keyPath: ["fileId", "index"] });
      if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) db.createObjectStore(FOLDER_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CELL_STORE_NAME)) db.createObjectStore(CELL_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STICKY_STORE_NAME)) db.createObjectStore(STICKY_STORE_NAME, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS_STORE_NAME)) db.createObjectStore(SETTINGS_STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getSetting(key) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(SETTINGS_STORE_NAME, "readonly");
    const request = tx.objectStore(SETTINGS_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => reject(request.error);
  });
}

function putSetting(key, value) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(SETTINGS_STORE_NAME, "readwrite");
    tx.objectStore(SETTINGS_STORE_NAME).put({ key, value });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getAllScripts() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function getAllFolders() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FOLDER_STORE_NAME, "readonly");
    const request = tx.objectStore(FOLDER_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putFolder(folder) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FOLDER_STORE_NAME, "readwrite");
    tx.objectStore(FOLDER_STORE_NAME).put(folder);
    tx.oncomplete = () => { scheduleDiskSync(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function removeFolderRecord(id) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FOLDER_STORE_NAME, "readwrite");
    tx.objectStore(FOLDER_STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getCells() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(CELL_STORE_NAME, "readonly");
    const request = tx.objectStore(CELL_STORE_NAME).get("main");
    request.onsuccess = () => resolve(request.result || { id: "main", activeSheetId: null, sheets: [] });
    request.onerror = () => reject(request.error);
  });
}

function putCells() {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(CELL_STORE_NAME, "readwrite");
    tx.objectStore(CELL_STORE_NAME).put(state.cells);
    tx.oncomplete = () => { scheduleDiskSync(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function getStickyNotes() {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STICKY_STORE_NAME, "readonly");
    const request = tx.objectStore(STICKY_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function putStickyNote(note) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STICKY_STORE_NAME, "readwrite");
    tx.objectStore(STICKY_STORE_NAME).put(note);
    tx.oncomplete = () => { scheduleDiskSync(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function removeStickyNote(id) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STICKY_STORE_NAME, "readwrite");
    tx.objectStore(STICKY_STORE_NAME).delete(id);
    tx.oncomplete = () => { scheduleDiskSync(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function putSongs() {
  scheduleDiskSync();
  return Promise.resolve();
}

function putScript(script) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(script);
    tx.oncomplete = () => { scheduleDiskSync(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

function removeScriptRecord(id) {
  if (state.diskVaultHandle) { scheduleDiskSync(); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function putAttachmentFile(fileRecord) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FILE_STORE_NAME, "readwrite");
    tx.objectStore(FILE_STORE_NAME).put(fileRecord);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getAttachmentFile(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FILE_STORE_NAME, "readonly");
    const request = tx.objectStore(FILE_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function removeAttachmentFile(id) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(FILE_STORE_NAME, "readwrite");
    tx.objectStore(FILE_STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function putFileChunk(fileId, index, blob) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(CHUNK_STORE_NAME, "readwrite");
    tx.objectStore(CHUNK_STORE_NAME).put({ fileId, index, blob });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function getFileChunk(fileId, index) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(CHUNK_STORE_NAME, "readonly");
    const request = tx.objectStore(CHUNK_STORE_NAME).get([fileId, index]);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error);
  });
}

function removeFileChunks(fileId) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(CHUNK_STORE_NAME, "readwrite");
    const range = IDBKeyRange.bound([fileId, 0], [fileId, Number.MAX_SAFE_INTEGER]);
    tx.objectStore(CHUNK_STORE_NAME).delete(range);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function formatDate(dateValue, options = {}) {
  return new Intl.DateTimeFormat("en-US", options).format(new Date(dateValue));
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function daysBetween(date) {
  return Math.round((date - startOfToday()) / 86400000);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function descendantsOf(id) {
  const output = [];
  const walk = parentId => {
    state.scripts.filter(script => script.parentId === parentId).forEach(script => {
      output.push(script);
      walk(script.id);
    });
  };
  walk(id);
  return output;
}

function ancestorsOf(script) {
  const output = [];
  let current = script;
  while (current) {
    output.unshift(current);
    current = state.scripts.find(item => item.id === current.parentId);
  }
  return output;
}

function toast(message, type = "success") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toastContainer").append(element);
  setTimeout(() => element.remove(), 3200);
}

function showTransfer(title, detail, kicker = "WORKING SAFELY", cancellable = false) {
  transferState.cancelled = false;
  transferState.mode = cancellable ? "upload" : null;
  transferState.startedAt = performance.now();
  $("#transferTitle").textContent = title;
  $("#transferDetail").textContent = detail;
  $("#transferKicker").textContent = kicker;
  updateTransfer(0, 1);
  $("#transferCancel").classList.toggle("hidden", !cancellable);
  $("#transferCancel").disabled = false;
  $("#transferCancel").textContent = "Cancel upload";
  $("#transferOverlay").classList.remove("hidden");
}

function updateTransfer(done, total, detail) {
  const safeTotal = Math.max(total, 1);
  const percent = Math.min(100, Math.round((done / safeTotal) * 100));
  $("#transferBar").style.width = `${percent}%`;
  $("#transferPercent").textContent = `${percent}%`;
  let progressText = `${formatBytes(done)} / ${formatBytes(total)}`;
  if (total >= 1024 * 1024 && done > 0 && transferState.startedAt) {
    const elapsed = Math.max((performance.now() - transferState.startedAt) / 1000, 0.1);
    const speed = done / elapsed;
    const remainingSeconds = speed > 0 ? Math.max(0, (total - done) / speed) : 0;
    const eta = remainingSeconds >= 60 ? `${Math.ceil(remainingSeconds / 60)} min left` : `${Math.ceil(remainingSeconds)} sec left`;
    progressText += ` · ${formatBytes(speed)}/s · ${eta}`;
  }
  $("#transferBytes").textContent = progressText;
  if (detail) $("#transferDetail").textContent = detail;
}

function hideTransfer() {
  $("#transferOverlay").classList.add("hidden");
  transferState.mode = null;
}

function assertTransferActive() {
  if (transferState.cancelled) {
    const error = new Error("Upload cancelled");
    error.name = "AbortError";
    throw error;
  }
}

async function updateStorageEstimate() {
  const uniqueAttachments = new Map();
  for (const script of state.scripts) {
    for (const file of script.attachments || []) if (!uniqueAttachments.has(file.id)) uniqueAttachments.set(file.id, file);
  }
  for (const song of state.songs) if (!uniqueAttachments.has(song.id)) uniqueAttachments.set(song.id, song);
  const attachmentCount = uniqueAttachments.size;
  const attachmentBytes = [...uniqueAttachments.values()].reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const recordBytes = new TextEncoder().encode(JSON.stringify({
    scripts: state.scripts.map(script => ({ ...script, attachments: (script.attachments || []).map(({ data, ...file }) => file) })),
    folders: state.folders,
    cells: state.cells,
    songs: state.songs
  })).byteLength;
  const logicalBytes = attachmentBytes + recordBytes;
  let physicalBytes = 0;
  let physicalFiles = 0;
  if (state.diskAttachmentsHandle) {
    try {
      for await (const handle of state.diskAttachmentsHandle.values()) {
        if (handle.kind !== "file") continue;
        const file = await handle.getFile();
        physicalBytes += file.size;
        physicalFiles++;
      }
    } catch {}
  }
  $("#storageUsed").textContent = state.diskVaultHandle
    ? `${formatBytes(physicalBytes + recordBytes)} physically on disk`
    : `${formatBytes(logicalBytes)} listed in Avaton`;
  $("#storageFileCount").textContent = `${attachmentCount} file${attachmentCount === 1 ? "" : "s"}`;
  $("#storageQuota").textContent = state.diskVaultHandle
    ? `${formatBytes(logicalBytes)} logical · ${physicalFiles} disk file${physicalFiles === 1 ? "" : "s"}`
    : "Disk Vault required";
  $("#diskFolderName").textContent = state.diskVaultHandle?.name || "Not selected";
  $("#storageBar").style.width = state.diskVaultHandle && physicalBytes ? "100%" : "0%";
}

function getAllStoreKeys(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, "readonly");
    const request = tx.objectStore(storeName).getAllKeys();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function cleanupUnusedStorage() {
  const referenced = new Set([
    ...state.scripts.flatMap(script => (script.attachments || []).map(file => file.id)),
    ...state.songs.map(song => song.id)
  ]);
  const chunkKeys = await getAllStoreKeys(CHUNK_STORE_NAME);
  const storedChunkIds = new Set(chunkKeys.map(key => Array.isArray(key) ? key[0] : key));
  const legacyKeys = await getAllStoreKeys(FILE_STORE_NAME);
  const unusedIds = new Set([
    ...[...storedChunkIds].filter(id => !referenced.has(id)),
    ...legacyKeys.filter(id => !referenced.has(id))
  ]);
  showTransfer("Cleaning unused storage", "Removing abandoned upload and old attachment data.", "STORAGE CLEANUP");
  try {
    let done = 0;
    for (const id of unusedIds) {
      await removeFileChunks(id);
      await removeAttachmentFile(id);
      done++;
      updateTransfer(done, Math.max(unusedIds.size, 1), `Removed ${done} of ${unusedIds.size} unused file records`);
    }
    await updateStorageEstimate();
    toast(unusedIds.size ? `${unusedIds.size} unused file record${unusedIds.size === 1 ? "" : "s"} removed` : "No unused Avaton file data was found");
  } finally {
    hideTransfer();
  }
}

let diskSyncTimer;
function scheduleDiskSync() {
  if (!state.diskVaultHandle) return;
  clearTimeout(diskSyncTimer);
  diskSyncTimer = setTimeout(() => syncDiskVault().catch(() => {
    $("#diskVaultStatus").textContent = "Disk save failed — reconnect the folder";
    $("#diskStatusDot").classList.remove("connected");
  }), 500);
}

function diskSafeName(name) {
  return String(name || "file").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 150);
}

async function resolveDiskAttachmentHandle(file, attachmentsHandle = state.diskAttachmentsHandle, vaultName = state.diskVaultHandle?.name) {
  if (!attachmentsHandle) throw new Error("The Disk Vault is not connected");
  if (file.diskName) {
    try {
      return await attachmentsHandle.getFileHandle(file.diskName);
    } catch (error) {
      if (error?.name !== "NotFoundError") throw error;
    }
  }
  const prefix = `${file.id}--`;
  try {
    for await (const [name, handle] of attachmentsHandle.entries()) {
      if (handle.kind === "file" && name.startsWith(prefix)) {
        file.diskName = name;
        return handle;
      }
    }
  } catch {}
  throw new Error(`“${file.name || "Unnamed attachment"}” is missing from Disk Vault “${vaultName || "selected folder"}”. Reconnect the original vault folder or restore this file from backup.`);
}

async function copyDiskFile(sourceHandle, destinationDirectory, destinationName, onProgress = () => {}) {
  const source = await sourceHandle.getFile();
  const destinationHandle = await destinationDirectory.getFileHandle(destinationName, { create: true });
  const writable = await destinationHandle.createWritable();
  try {
    for (let offset = 0; offset < source.size; offset += DISK_CHUNK_SIZE) {
      const part = source.slice(offset, Math.min(offset + DISK_CHUNK_SIZE, source.size));
      await writable.write(part);
      onProgress(part.size);
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await destinationDirectory.removeEntry(destinationName).catch(() => {});
    throw error;
  }
  const copied = await (await destinationDirectory.getFileHandle(destinationName)).getFile();
  if (copied.size !== source.size) {
    await destinationDirectory.removeEntry(destinationName).catch(() => {});
    throw new Error(`Verification failed while copying “${source.name}”`);
  }
  return copied.size;
}

function diskManifest() {
  return {
    app: "Avaton",
    version: 1,
    savedAt: new Date().toISOString(),
    scripts: state.scripts.map(script => ({ ...script, attachments: (script.attachments || []).map(({ data, ...file }) => file) })),
    folders: state.folders,
    cells: state.cells,
    stickyNotes: state.stickyNotes,
    songs: state.songs.map(({ url, ...song }) => song)
  };
}

async function syncDiskVault() {
  if (!state.diskVaultHandle) return;
  const fileHandle = await state.diskVaultHandle.getFileHandle("avaton-vault.json", { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(diskManifest(), null, 2));
  await writable.close();
  $("#diskVaultStatus").textContent = `Connected: ${state.diskVaultHandle.name} · saved just now`;
  $("#diskStatusDot").classList.add("connected");
  $("#syncDiskVaultButton").classList.remove("hidden");
  await updateStorageEstimate();
}

function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function clearBrowserVaultData() {
  await Promise.all([
    STORE_NAME,
    FOLDER_STORE_NAME,
    CELL_STORE_NAME,
    STICKY_STORE_NAME,
    FILE_STORE_NAME,
    CHUNK_STORE_NAME
  ].map(clearStore));
}

async function writeAttachmentToDisk(file, blob, onProgress = () => {}, cancellable = false) {
  const diskName = `${file.id}--${diskSafeName(ensureFilename(file.name, file.type))}`;
  const handle = await state.diskAttachmentsHandle.getFileHandle(diskName, { create: true });
  const writable = await handle.createWritable();
  try {
    for (let offset = 0; offset < blob.size; offset += DISK_CHUNK_SIZE) {
      if (cancellable) assertTransferActive();
      const part = blob.slice(offset, Math.min(offset + DISK_CHUNK_SIZE, blob.size));
      await writable.write(part);
      onProgress(part.size, Math.min(offset + part.size, blob.size));
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await state.diskAttachmentsHandle.removeEntry(diskName).catch(() => {});
    throw error;
  }
  file.diskName = diskName;
  file.storage = "disk";
  delete file.chunkCount;
  delete file.data;
}

async function streamStoredAttachmentToDisk(file, onProgress = () => {}) {
  const diskName = `${file.id}--${diskSafeName(ensureFilename(file.name, file.type))}`;
  const handle = await state.diskAttachmentsHandle.getFileHandle(diskName, { create: true });
  const writable = await handle.createWritable();
  let written = 0;
  try {
    if (file.storage === "chunks" || file.chunkCount) {
      const count = Number(file.chunkCount) || Math.ceil((Number(file.size) || 0) / CHUNK_SIZE);
      for (let index = 0; index < count; index++) {
        const chunk = await getFileChunk(file.id, index);
        if (!chunk) throw new Error(`A stored piece of ${file.name} is missing`);
        await writable.write(chunk);
        written += chunk.size;
        onProgress(chunk.size, written);
      }
    } else {
      const stored = await getAttachmentFile(file.id);
      let source = stored?.blob || null;
      if (!source && file.data) source = await (await fetch(file.data)).blob();
      if (!source) throw new Error(`File data is missing for ${file.name}`);
      for (let offset = 0; offset < source.size; offset += DISK_CHUNK_SIZE) {
        const part = source.slice(offset, Math.min(offset + DISK_CHUNK_SIZE, source.size));
        await writable.write(part);
        written += part.size;
        onProgress(part.size, written);
      }
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    await state.diskAttachmentsHandle.removeEntry(diskName).catch(() => {});
    throw error;
  }
  file.size = written;
  file.diskName = diskName;
  file.storage = "disk";
  delete file.chunkCount;
  delete file.data;
}

async function migrateCurrentDataToDisk() {
  const files = [
    ...state.scripts.flatMap(script => script.attachments || []),
    ...state.songs
  ];
  const uniqueFiles = new Map();
  for (const file of files) if (!uniqueFiles.has(file.id)) uniqueFiles.set(file.id, file);
  const total = [...uniqueFiles.values()].reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const migrated = new Map();
  let done = 0;
  showTransfer("Moving Avaton to disk", "Copying attachments into the selected vault folder.", "DISK VAULT");
  try {
    if (!files.length) updateTransfer(0, 1, "Saving scripts, folders, sheets, and notes");
    for (const script of state.scripts) {
      for (const file of script.attachments || []) {
        if (file.storage === "disk" && file.diskName) continue;
        if (migrated.has(file.id)) {
          Object.assign(file, migrated.get(file.id));
          delete file.chunkCount;
          delete file.data;
          continue;
        }
        await streamStoredAttachmentToDisk(file, amount => {
          done += amount;
          updateTransfer(done, Math.max(total, done, 1), `Saving ${file.name} · ${formatBytes(done)} copied`);
        });
        migrated.set(file.id, { size: file.size, diskName: file.diskName, storage: "disk" });
      }
      await putScript(script);
    }
    for (const song of state.songs) {
      if (song.storage === "disk" && song.diskName) continue;
      if (migrated.has(song.id)) {
        Object.assign(song, migrated.get(song.id));
        continue;
      }
      await streamStoredAttachmentToDisk(song, amount => {
        done += amount;
        updateTransfer(done, Math.max(total, done, 1), `Saving ${song.name} · ${formatBytes(done)} copied`);
      });
      migrated.set(song.id, { size: song.size, diskName: song.diskName, storage: "disk" });
    }
    await putSongs();
    await syncDiskVault();
    await clearBrowserVaultData();
    await updateStorageEstimate();
  } finally {
    hideTransfer();
  }
}

async function loadDiskVault(manifest) {
  showTransfer("Loading Disk Vault", "Reading scripts, folders, sheets, and sticky notes.", "DISK VAULT");
  updateTransfer(1, 4, "Reading the vault catalogue");
  await new Promise(resolve => requestAnimationFrame(resolve));
  state.scripts = Array.isArray(manifest.scripts) ? manifest.scripts.map(script => ({ ...script, parentId: null })) : [];
  state.folders = Array.isArray(manifest.folders) ? manifest.folders : [];
  state.cells = manifest.cells || { id: "main", activeSheetId: null, sheets: [] };
  state.stickyNotes = Array.isArray(manifest.stickyNotes) ? manifest.stickyNotes : [];
  state.songs = Array.isArray(manifest.songs) ? manifest.songs : [];
  try {
    updateTransfer(2, 4, `Loaded ${state.scripts.length} scripts and ${state.folders.length} folders`);
    await clearBrowserVaultData();
    updateTransfer(3, 4, "Building the dashboard");
    renderAll();
    await syncDiskVault();
    updateTransfer(4, 4, "Disk Vault ready");
  } finally {
    hideTransfer();
  }
}

async function transferDiskVault(sourceHandle, sourceAttachments, destinationHandle) {
  if (sourceHandle.isSameEntry && await sourceHandle.isSameEntry(destinationHandle)) return;
  const destinationAttachments = await destinationHandle.getDirectoryHandle("attachments", { create: true });
  const uniqueFiles = new Map();
  for (const script of state.scripts) {
    for (const file of script.attachments || []) if (!uniqueFiles.has(file.id)) uniqueFiles.set(file.id, file);
  }
  for (const song of state.songs) if (!uniqueFiles.has(song.id)) uniqueFiles.set(song.id, song);
  const total = [...uniqueFiles.values()].reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  let done = 0;
  const copiedNames = [];
  showTransfer("Moving Disk Vault", `Copying all data from ${sourceHandle.name} to ${destinationHandle.name}.`, "DISK LOCATION");
  try {
    for (const file of uniqueFiles.values()) {
      const sourceFileHandle = await resolveDiskAttachmentHandle(file, sourceAttachments, sourceHandle.name);
      const destinationName = file.diskName || `${file.id}--${diskSafeName(ensureFilename(file.name, file.type))}`;
      await copyDiskFile(sourceFileHandle, destinationAttachments, destinationName, amount => {
        done += amount;
        updateTransfer(done, Math.max(total, done, 1), `Copying ${file.name} · ${formatBytes(done)} verified`);
      });
      file.diskName = destinationName;
      file.storage = "disk";
      copiedNames.push(destinationName);
    }
    const manifestHandle = await destinationHandle.getFileHandle("avaton-vault.json", { create: true });
    const writer = await manifestHandle.createWritable();
    await writer.write(JSON.stringify(diskManifest(), null, 2));
    await writer.close();
    const verification = JSON.parse(await (await manifestHandle.getFile()).text());
    if (verification.app !== "Avaton" || !Array.isArray(verification.scripts)) throw new Error("The new vault manifest could not be verified");
  } catch (error) {
    for (const name of copiedNames) await destinationAttachments.removeEntry(name).catch(() => {});
    throw error;
  } finally {
    hideTransfer();
  }
}

async function activateDiskVault(handle, moveCurrentData = false) {
  const previousHandle = state.diskVaultHandle;
  const previousAttachments = state.diskAttachmentsHandle;
  if (moveCurrentData && previousHandle && previousAttachments) {
    if (previousHandle.isSameEntry && await previousHandle.isSameEntry(handle)) {
      toast("That folder is already your active Disk Vault");
      return;
    }
    let destinationManifest = null;
    try {
      const manifestHandle = await handle.getFileHandle("avaton-vault.json");
      destinationManifest = JSON.parse(await (await manifestHandle.getFile()).text());
    } catch {}
    if (destinationManifest?.app === "Avaton") {
      if (confirm(`“${handle.name}” already contains an Avaton vault. Load that existing vault instead of replacing it?`)) {
        state.diskVaultHandle = handle;
        state.diskAttachmentsHandle = await handle.getDirectoryHandle("attachments", { create: true });
        await loadDiskVault(destinationManifest);
        state.rememberedDiskVaultHandle = handle;
        await putSetting(DISK_HANDLE_KEY, handle);
        $("#connectDiskVaultButton").textContent = "Change disk vault folder";
        $("#diskRequiredModal").classList.add("hidden");
        toast(`Existing Disk Vault loaded from ${handle.name}`);
      } else {
        toast("Move cancelled. Choose an empty folder for the new Disk Vault.", "error");
      }
      return;
    }
    await transferDiskVault(previousHandle, previousAttachments, handle);
    state.diskVaultHandle = handle;
    state.diskAttachmentsHandle = await handle.getDirectoryHandle("attachments", { create: true });
    state.rememberedDiskVaultHandle = handle;
    await putSetting(DISK_HANDLE_KEY, handle);
    await syncDiskVault();
    $("#connectDiskVaultButton").textContent = "Change disk vault folder";
    $("#diskRequiredModal").classList.add("hidden");
    toast(`Disk Vault moved to ${handle.name}. The old folder was kept as a safety copy.`);
    return;
  }
  state.diskVaultHandle = handle;
  state.rememberedDiskVaultHandle = handle;
  state.diskAttachmentsHandle = await handle.getDirectoryHandle("attachments", { create: true });
  await putSetting(DISK_HANDLE_KEY, handle);
  let existingManifest = null;
  try {
    const manifestHandle = await handle.getFileHandle("avaton-vault.json");
    existingManifest = JSON.parse(await (await manifestHandle.getFile()).text());
  } catch {}
  if (existingManifest?.app === "Avaton") {
    await loadDiskVault(existingManifest);
    toast("Existing disk vault loaded");
  } else {
    await migrateCurrentDataToDisk();
    toast("Avaton data moved to the selected disk folder");
  }
  $("#connectDiskVaultButton").textContent = "Change disk vault folder";
  $("#chooseRequiredDiskVault").textContent = "Continue with saved Disk Vault";
  $("#diskRequiredModal").classList.add("hidden");
  renderStickyNotes();
}

async function restoreRememberedDiskVault(requestPermission = false) {
  const handle = state.rememberedDiskVaultHandle || await getSetting(DISK_HANDLE_KEY);
  if (!handle) return false;
  state.rememberedDiskVaultHandle = handle;
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && requestPermission) permission = await handle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    $("#chooseRequiredDiskVault").textContent = "Reconnect saved Disk Vault";
    $("#diskRequiredModal").classList.remove("hidden");
    return false;
  }
  await activateDiskVault(handle);
  return true;
}

async function connectDiskVault(forceNewFolder = false) {
  if (!window.showDirectoryPicker) {
    toast("Disk Vault requires a current Chrome or Edge browser opened from localhost or HTTPS", "error");
    return;
  }
  try {
    if (!forceNewFolder && await restoreRememberedDiskVault(true)) return;
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "avaton-disk-vault" });
    await activateDiskVault(handle, forceNewFolder);
  } catch (error) {
    if (error?.name !== "AbortError") toast(`Disk Vault failed: ${error.message || "folder access was denied"}`, "error");
    hideTransfer();
  }
}

function requireDiskVault() {
  if (state.diskVaultHandle) return true;
  $("#diskRequiredModal").classList.remove("hidden");
  toast("Choose a Disk Vault folder before editing", "error");
  return false;
}

async function createLargeFolderBackup(scriptsToBackup = state.scripts, songsToBackup = scriptsToBackup.length === state.scripts.length ? state.songs : []) {
  if (!window.showDirectoryPicker) {
    toast("Large folder backup requires a current Chrome or Edge browser", "error");
    return;
  }
  try {
    const destination = await window.showDirectoryPicker({ mode: "readwrite" });
    await validateBackupSources(scriptsToBackup, songsToBackup);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupRoot = await destination.getDirectoryHandle(`Avaton-Backup-${stamp}`, { create: true });
    const attachmentDir = await backupRoot.getDirectoryHandle("attachments", { create: true });
    const scripts = structuredClone(scriptsToBackup);
    const songs = structuredClone(songsToBackup).map(({ url, data, ...song }) => song);
    const isCompleteBackup = scriptsToBackup.length === state.scripts.length;
    const includedFolderIds = new Set(scripts.map(script => script.folderId).filter(Boolean));
    const folders = isCompleteBackup ? state.folders : state.folders.filter(folder => includedFolderIds.has(folder.id));
    const sourceFiles = new Map();
    for (const script of scripts) {
      for (const file of script.attachments || []) {
        const source = state.scripts.flatMap(item => item.attachments || []).find(item => item.id === file.id);
        const diskName = `${file.id}--${diskSafeName(ensureFilename(file.name, file.type))}`;
        file.storage = "disk";
        file.diskName = diskName;
        delete file.chunkCount;
        delete file.data;
        if (!sourceFiles.has(file.id)) sourceFiles.set(file.id, { source, diskName });
      }
    }
    for (const song of songs) {
      const source = state.songs.find(item => item.id === song.id);
      const diskName = song.diskName || `${song.id}--${diskSafeName(ensureFilename(song.name, song.type))}`;
      song.storage = "disk";
      song.diskName = diskName;
      if (!sourceFiles.has(song.id)) sourceFiles.set(song.id, { source, diskName });
    }
    const backupFiles = [...sourceFiles.values()];
    const total = backupFiles.reduce((sum, item) => sum + (item.source?.size || 0), 0);
    let done = 0;
    showTransfer("Creating backup folder", "Saving avaton-vault.json and attachments in one normal folder format.", "FOLDER BACKUP");
    for (const item of backupFiles) {
      const blob = await getAttachmentBlob(item.source);
      const handle = await attachmentDir.getFileHandle(item.diskName, { create: true });
      const writable = await handle.createWritable();
      for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        const part = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
        await writable.write(part);
        done += part.size;
        updateTransfer(done, Math.max(total, 1), `Backing up ${item.source.name}`);
      }
      await writable.close();
    }
    const manifestHandle = await backupRoot.getFileHandle("avaton-vault.json", { create: true });
    const manifestWriter = await manifestHandle.createWritable();
    await manifestWriter.write(JSON.stringify({
      app: "Avaton",
      version: 1,
      savedAt: new Date().toISOString(),
      backupCreatedAt: new Date().toISOString(),
      scripts,
      folders,
      cells: isCompleteBackup ? state.cells : null,
      stickyNotes: isCompleteBackup ? state.stickyNotes : [],
      songs: isCompleteBackup ? songs : []
    }, null, 2));
    await manifestWriter.close();
    toast(`Backup folder created in ${backupRoot.name}`);
  } catch (error) {
    if (error?.name !== "AbortError") toast(`Folder backup failed: ${error.message || "write permission was denied"}`, "error");
  } finally {
    hideTransfer();
  }
}

async function getBackupManifestInfo(backupRoot) {
  try {
    const manifestHandle = await backupRoot.getFileHandle("avaton-vault.json");
    return {
      manifest: JSON.parse(await (await manifestHandle.getFile()).text()),
      directory: await backupRoot.getDirectoryHandle("attachments"),
      format: "vault-folder"
    };
  } catch {}
  try {
    const manifestHandle = await backupRoot.getFileHandle("avaton-manifest.json");
    return {
      manifest: JSON.parse(await (await manifestHandle.getFile()).text()),
      directory: await backupRoot.getDirectoryHandle("files"),
      format: "extracted-zip"
    };
  } catch {}
  try {
    const manifestHandle = await backupRoot.getFileHandle("avaton-manifest");
    return {
      manifest: JSON.parse(await (await manifestHandle.getFile()).text()),
      directory: await backupRoot.getDirectoryHandle("files"),
      format: "extracted-zip"
    };
  } catch {}
  throw new Error("Choose the folder that contains avaton-vault.json or avaton-manifest.json");
}

async function getBackupFileHandle(source, backupDirectory, backupRootName, backupFormat) {
  if (backupFormat === "extracted-zip" && source.backupPath) {
    const parts = source.backupPath.split("/").filter(Boolean);
    let directory = backupDirectory;
    let start = parts[0] === "files" ? 1 : 0;
    for (let index = start; index < parts.length - 1; index++) {
      directory = await directory.getDirectoryHandle(parts[index]);
    }
    return directory.getFileHandle(parts[parts.length - 1]);
  }
  return resolveDiskAttachmentHandle(source, backupDirectory, backupRootName);
}

async function restoreLargeFolderBackup() {
  if (!window.showDirectoryPicker) {
    toast("Folder backup restore requires a current Chrome or Edge browser", "error");
    return;
  }
  if (!requireDiskVault()) return;
  const snapshot = await captureImportSnapshot();
  try {
    const backupRoot = await window.showDirectoryPicker({ mode: "read" });
    showTransfer("Restoring folder backup", "Checking the backup before changing Avaton.", "FOLDER RESTORE");
    const { manifest, directory: backupAttachments, format: backupFormat } = await getBackupManifestInfo(backupRoot);
    if (manifest.app !== "Avaton" || !Array.isArray(manifest.scripts)) throw new Error("This folder is not a complete Avaton backup");
    const sourceAttachments = [...new Map([
      ...manifest.scripts.flatMap(script => (script.attachments || []).map(item => [item.id, item])),
      ...(manifest.songs || []).map(song => [song.id, song])
    ]).values()];
    let total = sourceAttachments.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    let checked = 0;
    for (const source of sourceAttachments) {
      const handle = await getBackupFileHandle(source, backupAttachments, backupRoot.name, backupFormat);
      const file = await handle.getFile();
      if (Number(source.size) && file.size !== Number(source.size)) throw new Error(`${source.name || "A file"} is incomplete in this folder backup`);
      checked += file.size;
      updateTransfer(checked, Math.max(total, checked, 1), `Checked ${source.name || "file"}`);
    }
    const imported = prepareAdditiveImport(manifest, null, true);
    for (const folder of imported.folders) {
      await putFolder(folder);
      state.folders.push(folder);
    }
    if (imported.cells) {
      mergeImportedCells(imported.cells);
      await putCells();
    }
    for (const note of manifest.stickyNotes || []) {
      const importedNote = { ...note, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.stickyNotes.push(importedNote);
      await putStickyNote(importedNote);
    }
    const sourceById = new Map(sourceAttachments.map(item => [item.id, item]));
    let restored = 0;
    const restoredFiles = new Map();
    for (const script of imported.scripts) {
      for (const attachment of script.attachments || []) {
        if (restoredFiles.has(attachment.originalId)) {
          Object.assign(attachment, restoredFiles.get(attachment.originalId));
          delete attachment.originalId;
          continue;
        }
        const source = sourceById.get(attachment.originalId);
        if (!source) continue;
        const sourceHandle = await getBackupFileHandle(source, backupAttachments, backupRoot.name, backupFormat);
        const sourceFile = await sourceHandle.getFile();
        await writeAttachmentToDisk(attachment, sourceFile, amount => {
          restored += amount;
          updateTransfer(restored, Math.max(total, restored, 1), `Restoring ${attachment.name}`);
        });
        restoredFiles.set(attachment.originalId, {
          size: attachment.size,
          type: attachment.type,
          storage: attachment.storage,
          diskName: attachment.diskName
        });
        delete attachment.originalId;
      }
      await putScript(script);
      state.scripts.push(script);
    }
    for (const sourceSong of manifest.songs || []) {
      const song = { ...sourceSong, id: uid(), originalId: sourceSong.id, addedAt: new Date().toISOString() };
      const sourceHandle = await getBackupFileHandle(sourceSong, backupAttachments, backupRoot.name, backupFormat);
      const sourceFile = await sourceHandle.getFile();
      await writeAttachmentToDisk(song, sourceFile, amount => {
        restored += amount;
        updateTransfer(restored, Math.max(total, restored, 1), `Restoring ${song.name}`);
      });
      delete song.originalId;
      state.songs.push(song);
    }
    await putSongs();
    renderAll();
    openFolder(null);
    await updateStorageEstimate();
    toast("Folder backup restored as new data. Current data was preserved.");
  } catch (error) {
    await rollbackImport(snapshot);
    toast(`Folder restore failed safely: ${error.message || "backup could not be read"}. Current data was not changed.`, "error");
  } finally {
    hideTransfer();
  }
}

async function removeDiskAttachment(file) {
  if (!state.diskAttachmentsHandle || !file.diskName) return;
  try { await state.diskAttachmentsHandle.removeEntry(file.diskName); } catch {}
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("avaton-theme", theme);
  $("#themeLabel").textContent = theme === "dark" ? "Light mode" : "Dark mode";
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0c0e14" : "#f5f6fa";
}

function unlock() {
  $("#lockScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
  sessionStorage.setItem("avaton-unlocked", "true");
  $("#passwordInput").value = "";
  $("#loginError").textContent = "";
  renderAll();
  if (!state.diskVaultHandle) $("#diskRequiredModal").classList.remove("hidden");
}

function lock() {
  sessionStorage.removeItem("avaton-unlocked");
  $("#appShell").classList.add("hidden");
  $("#lockScreen").classList.remove("hidden");
  renderPasswordHint();
  setTimeout(() => $("#passwordInput").focus(), 50);
}

function showView(name) {
  $$(".view").forEach(view => view.classList.remove("active"));
  const target = $(`#${name}View`);
  if (target) target.classList.add("active");
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === name));
  closeSidebar();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#sidebarOverlay").classList.add("open");
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#sidebarOverlay").classList.remove("open");
}

function openCreateModal(parentId = null) {
  state.pendingParentId = parentId;
  state.chosenColor = parentId ? (state.scripts.find(s => s.id === parentId)?.color || COLORS[0]) : COLORS[state.scripts.length % COLORS.length];
  $("#modalSubtitle").textContent = parentId ? "This script will live inside the one you are currently viewing." : "Give your new script a name. You can change it anytime.";
  $("#newScriptTitle").value = "";
  renderColors();
  $("#scriptModal").classList.remove("hidden");
  setTimeout(() => $("#newScriptTitle").focus(), 50);
}

function closeCreateModal() {
  $("#scriptModal").classList.add("hidden");
  state.pendingParentId = null;
}

function renderColors() {
  $("#colorChoices").innerHTML = COLORS.map(color => `<button type="button" class="color-choice ${color === state.chosenColor ? "active" : ""}" style="background:${color}" data-color="${color}" aria-label="Choose ${color}"></button>`).join("");
}

async function createScript(title, parentId = null) {
  const now = new Date().toISOString();
  const script = { id: uid(), parentId: null, folderId: state.currentFolderId || null, title: title.trim() || "Untitled script", text: "", color: state.chosenColor, attachments: [], createdAt: now, updatedAt: now, lastOpenedAt: now };
  state.scripts.push(script);
  await putScript(script);
  renderAll();
  openEditor(script.id);
  toast("Script created");
}

function openEditor(id) {
  const script = state.scripts.find(item => item.id === id);
  if (!script) return;
  state.currentScriptId = id;
  script.lastOpenedAt = new Date().toISOString();
  putScript(script);
  renderEditor();
  renderSidebarTree();
  showView("editor");
}

let saveTimer;
let currentSongUrl = "";
let prioritySaveTimer;
function queueEditorSave() {
  const script = state.scripts.find(item => item.id === state.currentScriptId);
  if (!script) return;
  script.title = $("#editorTitle").value.trimStart() || "Untitled script";
  script.text = $("#editorText").value;
  script.updatedAt = new Date().toISOString();
  $("#saveStatus").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await putScript(script);
    $("#saveStatus").textContent = "Saved locally";
    renderSidebarTree();
    renderScriptGrid();
    renderRecentScripts();
  }, 450);
}

function renderAll() {
  $("#scriptCount").textContent = state.scripts.length;
  renderSidebarTree();
  renderCalendar();
  renderScriptGrid();
  renderFolders();
  renderCells();
  renderStickyNotes();
  renderSongs();
  renderRecentScripts();
  if (state.currentScriptId) renderEditor();
}

function renderStickyNotes() {
  $("#stickyNotes").innerHTML = state.stickyNotes.length ? state.stickyNotes.map(note => `<div class="sticky-note">
    <textarea data-sticky-id="${note.id}" placeholder="Write a quick note…">${escapeHTML(note.text || "")}</textarea>
    <button class="sticky-delete" data-delete-sticky="${note.id}" title="Delete note">×</button>
  </div>`).join("") : `<div class="mini-empty">No sticky notes yet.</div>`;
}

function sortedSongs() {
  return [...state.songs].sort((a, b) =>
    (Number(a.priority) || 999) - (Number(b.priority) || 999) ||
    String(a.addedAt || "").localeCompare(String(b.addedAt || "")) ||
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

function renderSongs() {
  const list = $("#songList");
  const player = $("#songPlayer");
  if (!list || !player) return;
  const currentId = player.dataset.songId || "";
  const current = state.songs.find(song => song.id === currentId);
  $("#songNowTitle").textContent = current?.name || "No song selected";
  $("#songNowMeta").textContent = current
    ? `${current.type || "media file"} · ${formatBytes(current.size || 0)}`
    : state.songs.length ? `${state.songs.length} song${state.songs.length === 1 ? "" : "s"} in playlist` : "Upload songs to begin.";
  list.innerHTML = state.songs.length ? sortedSongs().map(song => `<div class="song-row ${song.id === currentId ? "playing" : ""}" data-song-row="${song.id}">
    <div class="song-icon"><svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg></div>
    <div class="song-info"><strong>${escapeHTML(song.name || "Untitled song")}</strong><span>${escapeHTML(song.type || "media file")} · ${formatBytes(song.size || 0)}</span></div>
    <label class="song-priority">Priority <input type="number" min="1" max="999" value="${Number(song.priority) || 1}" data-song-priority="${song.id}"></label>
    <div class="song-actions">
      <button class="secondary-button small" data-play-song="${song.id}">Play</button>
      <button class="secondary-button small" data-repeat-one="${song.id}">Repeat</button>
      <button class="icon-button danger" data-delete-song="${song.id}" title="Delete song"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg></button>
    </div>
  </div>`).join("") : `<div class="empty-state panel"><div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg></div><h3>No songs yet</h3><p>Add MP3, MP4, or other audio/video files to build your playlist.</p></div>`;
  $("#repeatSongButton").textContent = currentId && player.dataset.repeatSongId === currentId ? "Repeat this song: On" : "Repeat this song: Off";
  renderDashboardPlayer();
}

function renderDashboardPlayer() {
  const card = $("#dashboardPlayer");
  const player = $("#songPlayer");
  if (!card || !player) return;
  const current = state.songs.find(song => song.id === player.dataset.songId);
  card.classList.toggle("hidden", !current);
  if (!current) return;
  $("#dashboardSongTitle").textContent = current.name || "Untitled song";
  $("#dashboardPlayPause").innerHTML = player.paused
    ? `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7Z"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>`;
  $("#dashboardRepeatSong").classList.toggle("active", player.dataset.repeatSongId === current.id);
  updateDashboardSeek();
}

function formatSongTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function updateDashboardSeek() {
  const player = $("#songPlayer");
  const seek = $("#dashboardSeek");
  if (!player || !seek) return;
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  seek.max = duration || 100;
  if (document.activeElement !== seek) seek.value = duration ? player.currentTime : 0;
  $("#dashboardCurrentTime").textContent = formatSongTime(player.currentTime || 0);
  $("#dashboardDuration").textContent = formatSongTime(duration);
}

function isSongVideo(song) {
  const extension = (song.name || "").split(".").pop().toLowerCase();
  return (song.type || "").startsWith("video/") || ["mp4","webm","ogg","mov","m4v","mkv","avi"].includes(extension);
}

function updateSongPreviewMode(song) {
  const preview = $("#songPreview");
  if (!preview) return;
  const video = isSongVideo(song);
  preview.classList.toggle("video-mode", video);
  preview.classList.toggle("audio-mode", !video);
}

async function playSong(id) {
  const song = state.songs.find(item => item.id === id);
  if (!song) return;
  const player = $("#songPlayer");
  try {
    const blob = await getAttachmentBlob(song);
    if (currentSongUrl) URL.revokeObjectURL(currentSongUrl);
    currentSongUrl = URL.createObjectURL(blob);
    player.src = currentSongUrl;
    player.dataset.songId = song.id;
    updateSongPreviewMode(song);
    renderSongs();
    await player.play();
    renderDashboardPlayer();
  } catch (error) {
    toast(error.message || "Song could not be played", "error");
  }
}

function playNextSong() {
  const player = $("#songPlayer");
  const currentId = player.dataset.songId;
  if (!state.songs.length) return;
  if (player.dataset.repeatSongId && player.dataset.repeatSongId === currentId) {
    playSong(currentId);
    return;
  }
  const playlist = sortedSongs();
  const index = playlist.findIndex(song => song.id === currentId);
  const next = playlist[((index < 0 ? 0 : index) + 1) % playlist.length];
  if (next) playSong(next.id);
}

function playPreviousSong() {
  const player = $("#songPlayer");
  const currentId = player.dataset.songId;
  if (!state.songs.length) return;
  const playlist = sortedSongs();
  const index = playlist.findIndex(song => song.id === currentId);
  const previous = playlist[((index < 0 ? 0 : index) - 1 + playlist.length) % playlist.length];
  if (previous) playSong(previous.id);
}

async function uploadSongs(fileList) {
  if (!requireDiskVault()) return;
  const files = [...fileList].filter(file => (file.type || "").startsWith("audio/") || (file.type || "").startsWith("video/") || /\.(mp3|mp4|m4a|wav|ogg|webm|mov)$/i.test(file.name));
  if (!files.length) {
    toast("Choose MP3, MP4, audio, or video files for the Song Player", "error");
    return;
  }
  const additions = [];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let completedBytes = 0;
  try {
    showTransfer("Adding songs", "Saving songs into the Disk Vault.", "SONG PLAYER", true);
    const nextPriority = state.songs.reduce((max, song) => Math.max(max, Number(song.priority) || 0), 0) + 1;
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      assertTransferActive();
      const song = { id: uid(), name: file.name, type: file.type || "application/octet-stream", size: file.size, priority: nextPriority + index, addedAt: new Date().toISOString(), storage: "disk" };
      await writeAttachmentToDisk(song, file, amount => {
        completedBytes += amount;
        updateTransfer(completedBytes, Math.max(totalBytes, 1), `Adding ${file.name}`);
      }, true);
      additions.push(song);
      state.songs.push(song);
    }
    await putSongs();
    renderSongs();
    await updateStorageEstimate();
    toast(`${additions.length} song${additions.length === 1 ? "" : "s"} added`);
  } catch (error) {
    for (const song of additions) await removeDiskAttachment(song);
    state.songs = state.songs.filter(song => !additions.some(item => item.id === song.id));
    if (error?.name === "AbortError") toast("Song upload cancelled and partial data removed");
    else toast(error.message || "Songs could not be added", "error");
  } finally {
    hideTransfer();
    $("#songInput").value = "";
  }
}

function renderSidebarTree() {
  const roots = state.scripts.filter(script => !script.folderId);
  const rootFolders = state.folders.filter(folder => !folder.parentId);
  const build = (items, depth = 0) => items.map(script => {
    return `<div class="tree-item" style="--depth:${depth}">
      <button class="tree-row ${state.currentScriptId === script.id ? "active" : ""}" data-open-script="${script.id}">
        <span class="tree-caret"></span>
        <span class="tree-color" style="background:${script.color}"></span>
        <span class="tree-title">${escapeHTML(script.title)}</span>
      </button>
    </div>`;
  }).join("");
  const buildFolders = (folders, depth = 0) => folders.map(folder => {
    const children = state.folders.filter(item => item.parentId === folder.id);
    const scripts = state.scripts.filter(item => item.folderId === folder.id);
    return `<div class="tree-item" style="--depth:${depth}">
      <button class="tree-row ${state.currentFolderId === folder.id ? "active" : ""}" data-open-folder="${folder.id}">
        <span class="tree-caret">›</span><span class="tree-color" style="background:#e39b47"></span>
        <span class="tree-title">${escapeHTML(folder.title)}</span>
      </button>
      ${buildFolders(children, depth + 1)}${build(scripts, depth + 1)}
    </div>`;
  }).join("");
  const content = buildFolders(rootFolders) + build(roots);
  $("#sidebarTree").innerHTML = content || `<div class="mini-empty">No scripts or folders yet</div>`;
}

function renderScriptGrid() {
  const query = state.search.toLowerCase();
  const matches = state.scripts
    .filter(script => query
      ? script.title.toLowerCase().includes(query) || script.text.toLowerCase().includes(query)
      : script.folderId === state.currentFolderId)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  $("#scriptGrid").innerHTML = matches.map(script => {
    const preview = script.text.trim().replace(/\s+/g, " ") || "A quiet space ready for your words.";
    return `<button class="script-card" style="--card-color:${script.color}" data-open-script="${script.id}">
      <span class="script-card-icon" style="background:${script.color}">${iconFolder}</span>
      <h3>${escapeHTML(script.title)}</h3>
      <p>${escapeHTML(preview)}</p>
      <div class="script-meta"><span>${script.attachments?.length || 0} files</span><span>${formatDate(script.updatedAt, { month: "short", day: "numeric" })}</span></div>
    </button>`;
  }).join("");
  $("#emptyScripts").classList.toggle("hidden", matches.length > 0 || !!query);
  if (!matches.length && query) $("#scriptGrid").innerHTML = `<div class="mini-empty">No scripts match “${escapeHTML(state.search)}”.</div>`;
}

function folderLineage(folderId) {
  const output = [];
  let current = state.folders.find(folder => folder.id === folderId);
  while (current) {
    output.unshift(current);
    current = state.folders.find(folder => folder.id === current.parentId);
  }
  return output;
}

function renderFolders() {
  const query = state.search.toLowerCase();
  const folders = state.folders.filter(folder => query ? folder.title.toLowerCase().includes(query) : folder.parentId === state.currentFolderId);
  $("#folderGrid").innerHTML = folders.map(folder => {
    const scriptCount = state.scripts.filter(script => script.folderId === folder.id).length;
    const childCount = state.folders.filter(item => item.parentId === folder.id).length;
    return `<button class="folder-card" data-open-folder="${folder.id}">
      <span class="folder-card-icon">${iconFolder}</span>
      <span class="folder-card-info"><strong>${escapeHTML(folder.title)}</strong><span>${scriptCount} scripts · ${childCount} folders</span></span>
    </button>`;
  }).join("");
  const lineage = folderLineage(state.currentFolderId);
  $("#folderBreadcrumb").innerHTML = `<button class="crumb" data-open-folder="">All scripts</button>${lineage.map(folder => `<span class="crumb-separator">/</span><button class="crumb" data-open-folder="${folder.id}">${escapeHTML(folder.title)}</button>`).join("")}`;
  $("#moveCurrentFolderButton").classList.toggle("hidden", !state.currentFolderId);
  $("#renameCurrentFolderButton").classList.toggle("hidden", !state.currentFolderId);
  $("#deleteCurrentFolderButton").classList.toggle("hidden", !state.currentFolderId);
}

function openRenameModal(type, id) {
  const item = type === "folder"
    ? state.folders.find(folder => folder.id === id)
    : state.scripts.find(script => script.id === id);
  if (!item) return;
  $("#renameModal").dataset.type = type;
  $("#renameModal").dataset.id = id;
  $("#renameModalTitle").textContent = `Rename ${type}`;
  $("#renameValue").value = item.title;
  $("#renameModal").classList.remove("hidden");
  setTimeout(() => $("#renameValue").select(), 50);
}

function closeRenameModal() {
  $("#renameModal").classList.add("hidden");
  $("#renameModal").dataset.type = "";
  $("#renameModal").dataset.id = "";
}

function openFolder(id) {
  state.currentFolderId = id || null;
  state.search = "";
  $("#searchInput").value = "";
  renderFolders();
  renderScriptGrid();
  renderSidebarTree();
  showView("scripts");
}

async function createFolder(title) {
  const now = new Date().toISOString();
  const folder = { id: uid(), parentId: state.currentFolderId || null, title: title.trim() || "Untitled folder", createdAt: now, updatedAt: now };
  state.folders.push(folder);
  await putFolder(folder);
  renderAll();
  toast("Folder created");
}

function folderDescendantIds(folderId) {
  const ids = new Set();
  const walk = id => state.folders.filter(folder => folder.parentId === id).forEach(folder => {
    ids.add(folder.id);
    walk(folder.id);
  });
  walk(folderId);
  return ids;
}

function openMoveFolderModal(folderId) {
  const folder = state.folders.find(item => item.id === folderId);
  if (!folder) return;
  const blocked = folderDescendantIds(folderId);
  blocked.add(folderId);
  $("#moveFolderTitle").textContent = `Move “${folder.title}”`;
  $("#moveFolderSelect").innerHTML = `<option value="">Top level</option>${state.folders
    .filter(item => !blocked.has(item.id))
    .map(item => `<option value="${item.id}" ${item.id === folder.parentId ? "selected" : ""}>${escapeHTML(folderLineage(item.id).map(part => part.title).join(" / "))}</option>`)
    .join("")}`;
  $("#moveFolderModal").dataset.folderId = folderId;
  $("#moveFolderModal").classList.remove("hidden");
}

function closeMoveFolderModal() {
  $("#moveFolderModal").classList.add("hidden");
  $("#moveFolderModal").dataset.folderId = "";
}

async function deleteCurrentFolder() {
  const folder = state.folders.find(item => item.id === state.currentFolderId);
  if (!folder) return;
  const scripts = state.scripts.filter(script => script.folderId === folder.id);
  const childFolders = state.folders.filter(item => item.parentId === folder.id);
  const destinationName = folder.parentId
    ? state.folders.find(item => item.id === folder.parentId)?.title || "the parent folder"
    : "the top level";
  const message = `Delete folder “${folder.title}”? Its ${scripts.length} script(s) and ${childFolders.length} child folder(s) will be moved to ${destinationName}. No script or file will be deleted.`;
  if (!confirm(message)) return;
  for (const script of scripts) {
    script.folderId = folder.parentId || null;
    script.parentId = null;
    script.updatedAt = new Date().toISOString();
    await putScript(script);
  }
  for (const child of childFolders) {
    child.parentId = folder.parentId || null;
    child.updatedAt = new Date().toISOString();
    await putFolder(child);
  }
  await removeFolderRecord(folder.id);
  state.folders = state.folders.filter(item => item.id !== folder.id);
  state.currentFolderId = folder.parentId || null;
  renderAll();
  openFolder(state.currentFolderId);
  toast("Folder deleted; its contents were preserved");
}

function mergeImportedCells(importedCells) {
  if (!importedCells) return;
  normalizeCells();
  const importedSheets = Array.isArray(importedCells.sheets)
    ? importedCells.sheets
    : [{ id: uid(), name: importedCells.name || "Imported Sheet", columns: importedCells.columns || [], rows: importedCells.rows || [] }];
  const existingNames = new Set(state.cells.sheets.map(sheet => sheet.name));
  for (const source of importedSheets) {
    let name = source.name || "Imported Sheet";
    if (existingNames.has(name)) {
      let number = 2;
      while (existingNames.has(`${name} (Imported ${number})`)) number++;
      name = `${name} (Imported ${number})`;
    }
    existingNames.add(name);
    const columnMap = new Map((source.columns || []).map(column => [column.id, uid()]));
    const sheet = {
      id: uid(),
      name,
      columns: (source.columns || []).map(column => ({ ...column, id: columnMap.get(column.id) })),
      rows: (source.rows || []).map(row => ({
        id: uid(),
        values: Object.fromEntries(Object.entries(row.values || {}).map(([columnId, value]) => [columnMap.get(columnId) || columnId, value]))
      }))
    };
    state.cells.sheets.push(sheet);
  }
}

function prepareAdditiveImport(manifest, targetFolderId = null, includeCells = true) {
  const folders = Array.isArray(manifest.folders) ? structuredClone(manifest.folders) : [];
  const scripts = Array.isArray(manifest.scripts) ? structuredClone(manifest.scripts) : [];
  const folderMap = new Map(folders.map(folder => [folder.id, uid()]));
  const scriptMap = new Map(scripts.map(script => [script.id, uid()]));
  const sourceScripts = new Map(scripts.map(script => [script.id, script]));
  const attachmentMap = new Map();
  for (const script of scripts) for (const attachment of script.attachments || []) attachmentMap.set(attachment.id, uid());

  const importedFolders = folders.map(folder => ({
    ...folder,
    id: folderMap.get(folder.id),
    parentId: folder.parentId && folderMap.has(folder.parentId) ? folderMap.get(folder.parentId) : targetFolderId,
    title: folder.title || "Imported folder"
  }));
  const importedScripts = scripts.map(script => {
    let sourceFolderId = script.folderId || null;
    let parent = script.parentId ? sourceScripts.get(script.parentId) : null;
    const visited = new Set();
    while (!sourceFolderId && parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      sourceFolderId = parent.folderId || null;
      parent = parent.parentId ? sourceScripts.get(parent.parentId) : null;
    }
    const mappedFolder = sourceFolderId && folderMap.has(sourceFolderId) ? folderMap.get(sourceFolderId) : targetFolderId;
    return {
      ...script,
      id: scriptMap.get(script.id),
      parentId: null,
      folderId: targetFolderId || mappedFolder || null,
      title: script.title || "Imported script",
      attachments: (script.attachments || []).map(attachment => ({ ...attachment, id: attachmentMap.get(attachment.id), originalId: attachment.id }))
    };
  });
  return { folders: importedFolders, scripts: importedScripts, cells: includeCells ? manifest.cells : null };
}

async function flattenNestedScripts() {
  const byId = new Map(state.scripts.map(script => [script.id, script]));
  let changed = false;
  for (const script of state.scripts) {
    if (!script.parentId) continue;
    let parent = byId.get(script.parentId);
    const visited = new Set();
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (parent.folderId) {
        script.folderId = parent.folderId;
        break;
      }
      parent = parent.parentId ? byId.get(parent.parentId) : null;
    }
    script.parentId = null;
    script.updatedAt = new Date().toISOString();
    await putScript(script);
    changed = true;
  }
  return changed;
}

function renderRecentScripts() {
  const recent = [...state.scripts].sort((a, b) => new Date(b.lastOpenedAt || b.updatedAt) - new Date(a.lastOpenedAt || a.updatedAt)).slice(0, 3);
  $("#recentScripts").innerHTML = recent.length ? recent.map(script => `<button class="recent-item" data-open-script="${script.id}">
    <span class="recent-icon" style="background:${script.color}">${iconFolder}</span>
    <span class="recent-text"><strong>${escapeHTML(script.title)}</strong><span>Edited ${formatDate(script.updatedAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></span>
  </button>`).join("") : `<div class="mini-empty">Create a script and it will appear here.</div>`;
}

function renderEditor() {
  const script = state.scripts.find(item => item.id === state.currentScriptId);
  if (!script) return;
  $("#editorTitle").value = script.title;
  $("#editorText").value = script.text;
  $("#editorColor").style.background = script.color;
  $("#scriptFolderSelect").innerHTML = `<option value="">No folder</option>${state.folders.map(folder => `<option value="${folder.id}" ${folder.id === script.folderId ? "selected" : ""}>${escapeHTML(folderLineage(folder.id).map(item => item.title).join(" / "))}</option>`).join("")}`;
  const folder = state.folders.find(item => item.id === script.folderId);
  $("#editorBreadcrumb").innerHTML = `<button class="crumb" data-go-view="scripts">All scripts</button>${folder ? `<span class="crumb-separator">/</span><button class="crumb" data-open-folder="${folder.id}">${escapeHTML(folder.title)}</button>` : ""}<span class="crumb-separator">/</span><span>${escapeHTML(script.title)}</span>`;
  renderAttachments(script);
}

function renderAttachments(script) {
  const attachments = script.attachments || [];
  $("#attachmentList").innerHTML = attachments.length ? attachments.map(file => `<div class="attachment">
    <span class="attachment-file-icon">${iconFile}</span>
    <span class="attachment-info"><strong>${escapeHTML(file.name)}</strong><span>${formatBytes(file.size)} · ${escapeHTML(file.type || "File")}</span></span>
    <span class="attachment-actions">
      <button class="icon-button" data-preview-file="${file.id}" title="Preview"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.7"/></svg></button>
      <button class="icon-button" data-download-file="${file.id}" title="Download"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M5 17v3h14v-3"/></svg></button>
      <button class="icon-button danger" data-remove-file="${file.id}" title="Remove"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7"/></svg></button>
    </span>
  </div>`).join("") : `<div class="mini-empty">No files attached.</div>`;
}

function renderCells() {
  normalizeCells();
  const sheet = getActiveSheet();
  const { columns, rows } = sheet;
  const columnLetter = index => {
    let value = ""; let number = index + 1;
    while (number) { number--; value = String.fromCharCode(65 + number % 26) + value; number = Math.floor(number / 26); }
    return value;
  };
  $("#cellsTable").innerHTML = `<thead><tr><th class="row-number"></th>${columns.map((column, index) =>
    `<th><span class="column-letter">${columnLetter(index)}</span><input class="column-name-input" data-column-name="${column.id}" value="${escapeHTML(column.name)}" aria-label="Column ${columnLetter(index)} name"></th>`
  ).join("")}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr><th class="row-number">${rowIndex + 1}</th>${columns.map((column, columnIndex) => {
    const value = row.values?.[column.id];
    const active = state.activeCell.row === rowIndex && state.activeCell.column === columnIndex;
    const attributes = `data-cell-row-index="${rowIndex}" data-cell-column-index="${columnIndex}" data-cell-row="${row.id}" data-cell-column="${column.id}"`;
    if (column.type === "checkbox") return `<td class="sheet-cell ${active ? "active" : ""}" ${attributes}><input type="checkbox" ${attributes} ${value ? "checked" : ""}></td>`;
    const inputType = column.type === "date" ? "date" : column.type === "number" ? "number" : "text";
    return `<td class="sheet-cell ${active ? "active" : ""}" ${attributes}><input type="${inputType}" ${attributes} value="${escapeHTML(value ?? "")}"></td>`;
  }).join("")}</tr>`).join("")}</tbody>`;
  $("#sheetNameInput").value = sheet.name;
  $("#sheetSizeLabel").textContent = `${rows.length} rows × ${columns.length} columns`;
  $("#sheetTabList").innerHTML = state.cells.sheets.map(item => `<button class="sheet-tab ${item.id === state.cells.activeSheetId ? "active" : ""}" data-sheet-id="${item.id}">${escapeHTML(item.name)}</button>`).join("");
  syncActiveCellControls();
}

function normalizeCells() {
  if (!Array.isArray(state.cells.sheets)) {
    const legacy = { id: uid(), name: state.cells.name || "Sheet 1", columns: state.cells.columns || [], rows: state.cells.rows || [] };
    state.cells = { id: "main", activeSheetId: legacy.id, sheets: [legacy] };
  }
  if (!state.cells.sheets.length) state.cells.sheets.push(makeSheet("Sheet 1"));
  if (!state.cells.sheets.some(sheet => sheet.id === state.cells.activeSheetId)) state.cells.activeSheetId = state.cells.sheets[0].id;
  const sheet = getActiveSheet();
  if (!sheet.columns.length) sheet.columns = Array.from({ length: 8 }, (_, index) => ({ id: uid(), name: `Column ${index + 1}`, type: "text" }));
  if (!sheet.rows.length) sheet.rows = Array.from({ length: 20 }, () => ({ id: uid(), values: {} }));
  state.activeCell.row = Math.min(state.activeCell.row, sheet.rows.length - 1);
  state.activeCell.column = Math.min(state.activeCell.column, sheet.columns.length - 1);
}

function makeSheet(name) {
  return {
    id: uid(),
    name,
    columns: Array.from({ length: 8 }, (_, index) => ({ id: uid(), name: `Column ${index + 1}`, type: "text" })),
    rows: Array.from({ length: 20 }, () => ({ id: uid(), values: {} }))
  };
}

function getActiveSheet() {
  return state.cells.sheets.find(sheet => sheet.id === state.cells.activeSheetId) || state.cells.sheets[0];
}

function getActiveCell() {
  const sheet = getActiveSheet();
  const row = sheet.rows[state.activeCell.row];
  const column = sheet.columns[state.activeCell.column];
  return { row, column, value: row?.values?.[column?.id] ?? "" };
}

function syncActiveCellControls() {
  const { row, column, value } = getActiveCell();
  if (!row || !column) return;
  const letter = (() => { let text = "", number = state.activeCell.column + 1; while (number) { number--; text = String.fromCharCode(65 + number % 26) + text; number = Math.floor(number / 26); } return text; })();
  $("#activeCellAddress").textContent = `${letter}${state.activeCell.row + 1}`;
  $("#activeCellType").value = column.type;
  $("#formulaInput").value = column.type === "checkbox" ? (value ? "TRUE" : "FALSE") : value;
}

function selectSheetCell(rowIndex, columnIndex, focus = false) {
  const sheet = getActiveSheet();
  state.activeCell = {
    row: Math.max(0, Math.min(rowIndex, sheet.rows.length - 1)),
    column: Math.max(0, Math.min(columnIndex, sheet.columns.length - 1))
  };
  $$(".sheet-cell.active").forEach(cell => cell.classList.remove("active"));
  const cell = $(`.sheet-cell[data-cell-row-index="${state.activeCell.row}"][data-cell-column-index="${state.activeCell.column}"]`);
  cell?.classList.add("active");
  syncActiveCellControls();
  if (focus) cell?.querySelector("input")?.focus();
}

async function setCellValue(rowIndex, columnIndex, value) {
  const sheet = getActiveSheet();
  const row = sheet.rows[rowIndex];
  const column = sheet.columns[columnIndex];
  if (!row || !column) return;
  row.values ||= {};
  row.values[column.id] = column.type === "checkbox" ? !!value : value;
  await putCells();
}

async function pasteSpreadsheet(text) {
  const sheet = getActiveSheet();
  const matrix = text.replace(/\r/g, "").split("\n").filter((line, index, all) => line || index < all.length - 1).map(line => line.split("\t"));
  if (!matrix.length) return;
  const neededRows = state.activeCell.row + matrix.length;
  const neededColumns = state.activeCell.column + Math.max(...matrix.map(row => row.length));
  while (sheet.rows.length < neededRows) sheet.rows.push({ id: uid(), values: {} });
  while (sheet.columns.length < neededColumns) sheet.columns.push({ id: uid(), name: `Column ${sheet.columns.length + 1}`, type: "text" });
  matrix.forEach((values, rowOffset) => values.forEach((value, columnOffset) => {
    const row = sheet.rows[state.activeCell.row + rowOffset];
    const column = sheet.columns[state.activeCell.column + columnOffset];
    row.values ||= {};
    row.values[column.id] = column.type === "checkbox" ? /^(true|yes|1|x|✓)$/i.test(value.trim()) : value;
  }));
  await putCells();
  renderCells();
}

async function getAttachmentBlob(file) {
  if (state.diskAttachmentsHandle) {
    try {
      const handle = await resolveDiskAttachmentHandle(file);
      const diskFile = await handle.getFile();
      return diskFile.type || !file.type ? diskFile : new File([diskFile], file.name || diskFile.name, { type: file.type });
    } catch (error) {
      if (file.storage === "disk" || file.diskName) throw error;
    }
  }
  if (file.storage === "chunks" || file.chunkCount) {
    const parts = [];
    for (let index = 0; index < file.chunkCount; index++) {
      const chunk = await getFileChunk(file.id, index);
      if (!chunk) throw new Error("A stored file piece is missing");
      parts.push(chunk);
    }
    return new Blob(parts, { type: file.type || "application/octet-stream" });
  }
  const stored = await getAttachmentFile(file.id);
  if (stored?.blob) return stored.blob;
  if (file.data) return (await fetch(file.data)).blob();
  throw new Error("File data is missing");
}

function findAttachmentById(id) {
  for (const script of state.scripts) {
    const file = (script.attachments || []).find(item => item.id === id);
    if (file) return { script, file };
  }
  return { script: null, file: null };
}

function zipEntryNames(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const names = [];
  for (let i = Math.max(0, bytes.length - 65557); i <= bytes.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(i + 28, true);
    const extraLength = view.getUint16(i + 30, true);
    const commentLength = view.getUint16(i + 32, true);
    names.push(new TextDecoder().decode(bytes.slice(i + 46, i + 46 + nameLength)));
    i += 45 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function previewAttachment(file) {
  const extension = (file.name || "").split(".").pop().toLowerCase();
  showTransfer("Opening preview", `Preparing ${file.name}`, "FILE VIEWER");
  try {
    const blob = await getAttachmentBlob(file);
    const effectiveType = file.type || blob.type || "";
    const isVideo = effectiveType.startsWith("video/") || ["mp4","webm","ogg","mov","m4v","mkv","avi","3gp"].includes(extension);
    const isAudio = effectiveType.startsWith("audio/") || ["mp3","wav","m4a","aac","flac","mpeg"].includes(extension);
    const isText = effectiveType.startsWith("text/") || ["txt","md","csv","json","js","css","html","xml","log","ini","yaml","yml"].includes(extension);
    if (!isVideo && blob.size > 750 * 1024 * 1024) {
      hideTransfer();
      toast("Very large non-video previews are limited to protect your laptop. Download this file instead", "error");
      return;
    }
    const url = URL.createObjectURL(blob);
    $("#viewerTitle").textContent = file.name;
    if (effectiveType.startsWith("image/") || ["jpg","jpeg","png","gif","webp","bmp","svg","avif"].includes(extension)) {
      $("#viewerBody").innerHTML = `<img src="${url}" alt="">`;
    } else if (isAudio) {
      $("#viewerBody").innerHTML = `<audio src="${url}" controls autoplay style="width:min(720px,100%)"></audio>`;
    } else if (isVideo) {
      $("#viewerBody").innerHTML = `<video src="${url}" controls preload="metadata" playsinline></video>`;
    } else if (effectiveType === "application/pdf" || extension === "pdf") {
      $("#viewerBody").innerHTML = `<iframe src="${url}" title="PDF preview"></iframe>`;
    } else if (isText && blob.size <= 15 * 1024 * 1024) {
      const text = await blob.text();
      URL.revokeObjectURL(url);
      $("#viewerBody").innerHTML = `<pre class="text-preview">${escapeHTML(text)}</pre>`;
    } else if (extension === "zip" || effectiveType === "application/zip" || effectiveType === "application/x-zip-compressed") {
      const names = zipEntryNames(await blob.arrayBuffer());
      URL.revokeObjectURL(url);
      $("#viewerBody").innerHTML = `<div class="zip-list">${names.length ? names.slice(0, 3000).map(name => `<div class="zip-entry">${escapeHTML(name)}</div>`).join("") : `<div class="mini-empty">No readable ZIP entries found.</div>`}</div>`;
    } else {
      URL.revokeObjectURL(url);
      $("#viewerBody").innerHTML = `<div class="mini-empty">This file type has no built-in viewer.<br><br>You can still download it from the file row.</div>`;
    }
    $("#viewerModal").dataset.url = url;
    $("#viewerModal").classList.remove("hidden");
  } catch (error) {
    $("#viewerTitle").textContent = file.name || "Preview error";
    $("#viewerBody").innerHTML = `<div class="mini-empty">${escapeHTML(error.message || "Preview could not be opened. Reconnect the Disk Vault folder and try again.")}</div>`;
    $("#viewerModal").dataset.url = "";
    $("#viewerModal").classList.remove("hidden");
    toast("Preview could not be opened", "error");
  } finally {
    hideTransfer();
  }
}

function closeViewer() {
  const url = $("#viewerModal").dataset.url;
  if (url) URL.revokeObjectURL(url);
  $("#viewerModal").dataset.url = "";
  $("#viewerModal").classList.add("hidden");
  $("#viewerBody").innerHTML = "";
}

function ensureFilename(name, type = "") {
  if (/\.[a-z0-9]{1,12}$/i.test(name)) return name;
  const extensions = { "application/zip": ".zip", "application/x-zip-compressed": ".zip", "application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "video/mp4": ".mp4", "video/webm": ".webm" };
  return name + (extensions[type] || "");
}

let crcTable;
function crc32Update(crc, bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let k = 0; k < 8; k++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

function zipDateTime(date = new Date()) {
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
    date: (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
  };
}

function zipLocalHeader(nameBytes, method) {
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  const stamp = zipDateTime();
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint16(6, 0x0808, true);
  view.setUint16(8, method, true); view.setUint16(10, stamp.time, true); view.setUint16(12, stamp.date, true);
  view.setUint16(26, nameBytes.length, true); header.set(nameBytes, 30);
  return header;
}

function zipDescriptor(crc, compressedSize, size) {
  const bytes = new Uint8Array(16); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true); view.setUint32(4, crc, true); view.setUint32(8, compressedSize, true); view.setUint32(12, size, true);
  return bytes;
}

function zipCentralHeader(entry) {
  const bytes = new Uint8Array(46 + entry.nameBytes.length); const view = new DataView(bytes.buffer); const stamp = zipDateTime();
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 20, true); view.setUint16(6, 20, true); view.setUint16(8, 0x0808, true);
  view.setUint16(10, entry.method, true); view.setUint16(12, stamp.time, true); view.setUint16(14, stamp.date, true);
  view.setUint32(16, entry.crc, true); view.setUint32(20, entry.compressedSize, true); view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true); view.setUint32(42, entry.offset, true); bytes.set(entry.nameBytes, 46);
  return bytes;
}

function zipEnd(count, centralSize, centralOffset) {
  const bytes = new Uint8Array(22); const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, count, true); view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, centralOffset, true);
  return bytes;
}

async function attachmentChunks(file) {
  const chunks = [];
  if (file.storage === "disk" && file.diskName && state.diskAttachmentsHandle) {
    const handle = await resolveDiskAttachmentHandle(file);
    const source = await handle.getFile();
    for (let offset = 0; offset < source.size; offset += CHUNK_SIZE) {
      chunks.push(source.slice(offset, Math.min(offset + CHUNK_SIZE, source.size)));
    }
    return chunks;
  }
  if (file.storage === "chunks" || file.chunkCount) {
    for (let index = 0; index < file.chunkCount; index++) chunks.push(await getFileChunk(file.id, index));
  } else chunks.push(await getAttachmentBlob(file));
  return chunks;
}

async function storeImportedBlob(attachment, blob, onProgress = () => {}) {
  attachment.size = blob.size;
  attachment.type = attachment.type || blob.type || "application/octet-stream";
  if (state.diskVaultHandle) {
    await writeAttachmentToDisk(attachment, blob, onProgress);
    return;
  }
  const chunkCount = Math.ceil(blob.size / CHUNK_SIZE);
  for (let index = 0; index < chunkCount; index++) {
    const part = blob.slice(index * CHUNK_SIZE, Math.min((index + 1) * CHUNK_SIZE, blob.size));
    await putFileChunk(attachment.id, index, part);
    onProgress(part.size);
  }
  attachment.chunkCount = chunkCount;
  attachment.storage = "chunks";
}

function uniqueFilesFrom(scripts = state.scripts, songs = []) {
  const files = new Map();
  for (const script of scripts) {
    for (const file of script.attachments || []) if (!files.has(file.id)) files.set(file.id, file);
  }
  for (const song of songs || []) if (!files.has(song.id)) files.set(song.id, song);
  return files;
}

async function validateBackupSources(scripts, songs = []) {
  const files = new Map();
  for (const script of scripts) {
    for (const file of script.attachments || []) if (!files.has(file.id)) files.set(file.id, file);
  }
  for (const song of songs || []) if (!files.has(song.id)) files.set(song.id, song);
  for (const file of files.values()) {
    if (file.storage === "disk" || file.diskName) {
      const handle = await resolveDiskAttachmentHandle(file);
      const source = await handle.getFile();
      if (Number(file.size) && source.size !== Number(file.size)) {
        throw new Error(`“${file.name}” is incomplete in Disk Vault “${state.diskVaultHandle?.name || "selected folder"}” (${formatBytes(source.size)} found, ${formatBytes(file.size)} expected).`);
      }
      continue;
    }
    if (file.storage === "chunks" || file.chunkCount) {
      const count = Number(file.chunkCount) || Math.ceil((Number(file.size) || 0) / CHUNK_SIZE);
      for (let index = 0; index < count; index++) {
        if (!await getFileChunk(file.id, index)) throw new Error(`A stored piece of “${file.name}” is missing`);
      }
      continue;
    }
    const legacy = await getAttachmentFile(file.id);
    if (!legacy?.blob && !file.data) throw new Error(`File data is missing for “${file.name}”`);
  }
}

async function captureImportSnapshot() {
  const diskNames = new Set();
  if (state.diskAttachmentsHandle) {
    try {
      for await (const [name, handle] of state.diskAttachmentsHandle.entries()) {
        if (handle.kind === "file") diskNames.add(name);
      }
    } catch {}
  }
  return {
    scripts: structuredClone(state.scripts),
    folders: structuredClone(state.folders),
    cells: structuredClone(state.cells),
    stickyNotes: structuredClone(state.stickyNotes),
    songs: structuredClone(state.songs),
    attachmentIds: new Set([
      ...state.scripts.flatMap(script => (script.attachments || []).map(file => file.id)),
      ...state.songs.map(song => song.id)
    ]),
    diskNames
  };
}

async function rollbackImport(snapshot) {
  const addedFiles = state.scripts
    .flatMap(script => script.attachments || [])
    .concat(state.songs)
    .filter(file => !snapshot.attachmentIds.has(file.id));
  for (const file of addedFiles) {
    await removeDiskAttachment(file).catch(() => {});
    await removeFileChunks(file.id).catch(() => {});
    await removeAttachmentFile(file.id).catch(() => {});
  }
  if (state.diskAttachmentsHandle) {
    try {
      for await (const [name, handle] of state.diskAttachmentsHandle.entries()) {
        if (handle.kind === "file" && !snapshot.diskNames.has(name)) {
          await state.diskAttachmentsHandle.removeEntry(name).catch(() => {});
        }
      }
    } catch {}
  }
  state.scripts = snapshot.scripts;
  state.folders = snapshot.folders;
  state.cells = snapshot.cells;
  state.stickyNotes = snapshot.stickyNotes;
  state.songs = snapshot.songs;
  if (state.diskVaultHandle) await syncDiskVault();
  renderAll();
}

async function createZipBackup(scripts, filename, songsToBackup = scripts.length === state.scripts.length ? state.songs : []) {
  const includedFolderIds = new Set(scripts.map(script => script.folderId).filter(Boolean));
  const folders = scripts.length === state.scripts.length ? state.folders : state.folders.filter(folder => includedFolderIds.has(folder.id));
  const cleanScripts = structuredClone(scripts).map(script => ({ ...script, attachments: (script.attachments || []).map(({ data, ...file }) => ({ ...file, backupPath: `files/${file.id}/${ensureFilename(file.name, file.type)}` })) }));
  const cleanSongs = structuredClone(songsToBackup).map(({ url, data, ...song }) => ({ ...song, backupPath: `files/${song.id}/${ensureFilename(song.name, song.type)}` }));
  const manifest = { app: "Avaton", version: 6, format: "zip", exportedAt: new Date().toISOString(), folders, cells: state.cells, stickyNotes: state.stickyNotes, songs: cleanSongs, scripts: cleanScripts };
  const entries = [{ name: "avaton-manifest.json", bytes: new TextEncoder().encode(JSON.stringify(manifest)) }];
  const includedFiles = new Map();
  for (const script of scripts) for (const file of script.attachments || []) if (!includedFiles.has(file.id)) includedFiles.set(file.id, file);
  for (const song of songsToBackup) if (!includedFiles.has(song.id)) includedFiles.set(song.id, song);
  for (const file of includedFiles.values()) entries.push({ name: `files/${file.id}/${ensureFilename(file.name, file.type)}`, file });
  const estimated = entries.reduce((sum, entry) => sum + (entry.bytes?.length || entry.file?.size || 0), 0);
  if (estimated >= 0xffffffff) {
    toast("This backup is over 4 GB. Split it by exporting individual scripts; browser ZIP64 is not safely supported", "error");
    return;
  }
  if (!window.showSaveFilePicker) {
    toast("Use current Chrome or Edge so Avaton can save the backup to the exact location you choose", "error");
    return;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      id: "avaton-zip-backup",
      suggestedName: filename,
      types: [{ description: "Compressed Avaton backup", accept: { "application/zip": [".zip"] } }],
      excludeAcceptAllOption: true
    });
  } catch (error) {
    if (error?.name !== "AbortError") toast("The Save As window was blocked. Click Export again and allow file saving.", "error");
    return;
  }
  try {
    await validateBackupSources(scripts, songsToBackup);
  } catch (error) {
    toast(`Backup cannot start: ${error.message}`, "error");
    return;
  }
  let writable = null; let position = 0; const central = [];
  const write = async value => { await writable.write(value); position += value.size ?? value.byteLength; };
  try {
    writable = await handle.createWritable();
    showTransfer("Creating compressed ZIP backup", "Compressing your vault. Already-compressed videos and ZIP files may not shrink much.", "ZIP BACKUP");
    let processed = 0;
    for (const entry of entries) {
      const nameBytes = new TextEncoder().encode(entry.name);
      const offset = position;
      const method = typeof CompressionStream === "function" ? 8 : 0;
      await write(zipLocalHeader(nameBytes, method));
      const sourceChunks = entry.bytes ? [new Blob([entry.bytes])] : await attachmentChunks(entry.file);
      let crc = 0xffffffff, size = 0, compressedSize = 0;
      let sourceIndex = 0;
      const source = new ReadableStream({
        async pull(controller) {
          if (sourceIndex >= sourceChunks.length) { controller.close(); return; }
          const bytes = new Uint8Array(await sourceChunks[sourceIndex++].arrayBuffer());
          crc = crc32Update(crc, bytes); size += bytes.length; controller.enqueue(bytes);
        }
      });
      const output = method === 8 ? source.pipeThrough(new CompressionStream("deflate-raw")) : source;
      const reader = output.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await write(value); compressedSize += value.byteLength;
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      await write(zipDescriptor(crc, compressedSize, size));
      central.push({ nameBytes, method, crc, compressedSize, size, offset });
      processed += size;
      updateTransfer(processed, Math.max(estimated, 1), `Compressed ${entry.name.split("/").pop()}`);
    }
    const centralOffset = position;
    for (const entry of central) await write(zipCentralHeader(entry));
    const centralSize = position - centralOffset;
    await write(zipEnd(central.length, centralSize, centralOffset));
    await writable.close();
    writable = null;
    toast(`Backup saved as ${handle.name}`);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    if (error?.name !== "AbortError") toast(`ZIP backup failed: ${error?.message || "browser could not write it"}`, "error");
  } finally { hideTransfer(); }
}

function zipEntriesFromBlob(blob) {
  return blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer); const view = new DataView(buffer); let eocd = -1;
    for (let i = bytes.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Invalid ZIP backup");
    const count = view.getUint16(eocd + 10, true), centralOffset = view.getUint32(eocd + 16, true);
    return blob.slice(centralOffset).arrayBuffer().then(centralBuffer => {
      const cv = new DataView(centralBuffer); const cb = new Uint8Array(centralBuffer); const entries = []; let offset = 0;
      for (let index = 0; index < count; index++) {
        if (cv.getUint32(offset, true) !== 0x02014b50) throw new Error("Broken ZIP directory");
        const method = cv.getUint16(offset + 10, true), compressedSize = cv.getUint32(offset + 20, true), size = cv.getUint32(offset + 24, true);
        const nameLength = cv.getUint16(offset + 28, true), extraLength = cv.getUint16(offset + 30, true), commentLength = cv.getUint16(offset + 32, true);
        const localOffset = cv.getUint32(offset + 42, true), name = new TextDecoder().decode(cb.slice(offset + 46, offset + 46 + nameLength));
        entries.push({ name, method, compressedSize, size, localOffset }); offset += 46 + nameLength + extraLength + commentLength;
      }
      return entries;
    });
  });
}

async function readZipEntry(zip, entry, onProgress = () => {}) {
  const local = await zip.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer();
  const view = new DataView(local); const nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = zip.slice(start, start + entry.compressedSize);
  if (entry.method === 0) {
    onProgress(entry.size);
    return compressed;
  }
  if (entry.method !== 8 || typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress the backup");
  const reader = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    onProgress(value.byteLength);
  }
  return new Blob(parts);
}

async function importZipBackup(file, targetFolderId = null, includeCells = true) {
  const snapshot = await captureImportSnapshot();
  showTransfer("Restoring ZIP backup", "Reading scripts, cells, folders, and files.", "ZIP RESTORE");
  try {
    const entries = await zipEntriesFromBlob(file);
    const manifestEntry = entries.find(entry => entry.name === "avaton-manifest.json");
    if (!manifestEntry) throw new Error("Avaton manifest is missing");
    updateTransfer(0, 1, "Reading the backup catalogue");
    const manifest = JSON.parse(await (await readZipEntry(file, manifestEntry)).text());
    if (manifest.app !== "Avaton") throw new Error("This is not an Avaton backup");
    const imported = prepareAdditiveImport(manifest, targetFolderId, includeCells);
    for (const folder of imported.folders) { await putFolder(folder); state.folders.push(folder); }
    if (imported.cells) { mergeImportedCells(imported.cells); await putCells(); }
    for (const note of manifest.stickyNotes || []) {
      const importedNote = { ...note, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.stickyNotes.push(importedNote);
      await putStickyNote(importedNote);
    }
    const restoreTotal = [...new Map(manifest.scripts.flatMap(script => (script.attachments || []).map(item => [item.id, item]))).values()]
      .reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    let restored = 0;
    let processedWork = 0;
    const totalWork = Math.max(restoreTotal * 2, 1);
    const restoredFiles = new Map();
    for (const script of imported.scripts) {
      for (const attachment of script.attachments || []) {
        if (restoredFiles.has(attachment.originalId)) {
          Object.assign(attachment, restoredFiles.get(attachment.originalId));
          delete attachment.originalId;
          delete attachment.backupPath;
          continue;
        }
        const zipEntry = entries.find(entry => entry.name === attachment.backupPath);
        if (!zipEntry) throw new Error(`Missing ${attachment.name}`);
        const blob = await readZipEntry(file, zipEntry, amount => {
          processedWork += amount;
          updateTransfer(processedWork, totalWork, `Decompressing ${attachment.name}`);
        });
        await storeImportedBlob(attachment, blob, amount => {
          restored += amount;
          processedWork += amount;
          updateTransfer(processedWork, totalWork, `Saving ${attachment.name} to Disk Vault`);
        });
        restoredFiles.set(attachment.originalId, {
          size: attachment.size,
          type: attachment.type,
          storage: attachment.storage,
          diskName: attachment.diskName,
          chunkCount: attachment.chunkCount
        });
        delete attachment.backupPath;
        delete attachment.originalId;
      }
      await putScript(script);
      state.scripts.push(script);
    }
    for (const sourceSong of manifest.songs || []) {
      const song = { ...sourceSong, id: uid(), addedAt: new Date().toISOString() };
      const zipEntry = entries.find(entry => entry.name === sourceSong.backupPath);
      if (!zipEntry) throw new Error(`Missing ${sourceSong.name}`);
      const blob = await readZipEntry(file, zipEntry, amount => {
        processedWork += amount;
        updateTransfer(processedWork, Math.max(totalWork, processedWork, 1), `Decompressing ${sourceSong.name}`);
      });
      await storeImportedBlob(song, blob, amount => {
        restored += amount;
        processedWork += amount;
        updateTransfer(processedWork, Math.max(totalWork, processedWork, 1), `Saving ${sourceSong.name} to Disk Vault`);
      });
      delete song.backupPath;
      state.songs.push(song);
    }
    await putSongs();
    renderAll(); openFolder(targetFolderId); toast("Backup imported as new data; previous data was preserved");
  } catch (error) {
    await rollbackImport(snapshot);
    toast(`Restore failed safely: ${error.message}. Current data was not changed.`, "error");
  }
  finally { hideTransfer(); clearImportInput(); }
}

function renderCalendar() {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  $("#calendarTitle").textContent = state.calendarYear;
  $("#monthTabs").innerHTML = months.map((month, index) => `<button class="month-tab ${index === state.calendarMonth ? "active" : ""}" data-month="${index}">${month}</button>`).join("");
  const first = new Date(state.calendarYear, state.calendarMonth, 1);
  const dayOffset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
  const today = startOfToday();
  const cells = [];
  for (let i = 0; i < dayOffset; i++) cells.push(`<div class="calendar-day empty"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(state.calendarYear, state.calendarMonth, day);
    const difference = daysBetween(date);
    const iso = `${state.calendarYear}-${String(state.calendarMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const isToday = date.getTime() === today.getTime();
    const selected = state.selectedDate === iso;
    const countdown = difference === 0 ? "Today" : difference > 0 ? `${difference}d left` : `${Math.abs(difference)}d ago`;
    cells.push(`<button class="calendar-day ${difference < 0 ? "past" : ""} ${isToday ? "today" : ""} ${selected ? "selected" : ""}" data-date="${iso}">
      <span class="day-number">${day}</span><span class="day-count">${countdown}</span>
    </button>`);
  }
  $("#calendarGrid").innerHTML = cells.join("");
}

function selectCalendarDate(iso) {
  state.selectedDate = iso;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const difference = daysBetween(date);
  $("#focusDateNumber").textContent = Math.abs(difference);
  $("#focusDateTitle").textContent = difference === 0 ? "Today is the day" : difference > 0 ? `${difference === 1 ? "Day" : "Days"} remaining` : `${Math.abs(difference) === 1 ? "Day" : "Days"} ago`;
  $("#focusDateText").textContent = formatDate(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  $("#selectedDateLabel").textContent = difference === 0 ? "That date is today" : difference > 0 ? `${difference} days until ${formatDate(date, { month: "short", day: "numeric" })}` : `${Math.abs(difference)} days since ${formatDate(date, { month: "short", day: "numeric" })}`;
  renderCalendar();
}

async function handleFiles(fileList) {
  const script = state.scripts.find(item => item.id === state.currentScriptId);
  if (!script) return;
  const files = [...fileList];
  const additions = [];
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    showTransfer("Uploading files", "Storing every file in small disk-backed pieces.", "LOCAL UPLOAD", true);
    for (const file of files) {
      assertTransferActive();
      const id = uid();
      if (state.diskVaultHandle) {
        const descriptor = { id, name: file.name, type: file.type, size: file.size, storage: "disk" };
        await writeAttachmentToDisk(descriptor, file, amount => {
          completedBytes += amount;
          const percent = totalBytes ? Math.round((completedBytes / totalBytes) * 100) : 100;
          updateTransfer(completedBytes, Math.max(totalBytes, 1), `Uploading ${file.name} · ${percent}%`);
        }, true);
        additions.push(descriptor);
        continue;
      }
      const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
      try {
        for (let index = 0; index < chunkCount; index++) {
          assertTransferActive();
          const start = index * CHUNK_SIZE;
          const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
          await putFileChunk(id, index, chunk);
          completedBytes += chunk.size;
          updateTransfer(completedBytes, totalBytes, `Uploading ${file.name} · piece ${index + 1} of ${chunkCount}`);
        }
        additions.push({ id, name: file.name, type: file.type, size: file.size, chunkCount, storage: "chunks" });
      } catch (error) {
        await removeFileChunks(id);
        throw error;
      }
    }
    script.attachments = [...(script.attachments || []), ...additions];
    script.updatedAt = new Date().toISOString();
    await putScript(script);
    renderAttachments(script);
    renderScriptGrid();
    await updateStorageEstimate();
    toast(`${additions.length} file${additions.length === 1 ? "" : "s"} attached`);
  } catch (error) {
    for (const attachment of additions) {
      if (attachment.storage === "disk") await removeDiskAttachment(attachment);
      else await removeFileChunks(attachment.id).catch(() => {});
    }
    if (error?.name === "AbortError") {
      toast("Upload cancelled and partial data removed");
      return;
    }
    const quotaProblem = error?.name === "QuotaExceededError";
    toast(quotaProblem ? "Not enough browser storage or disk space for that file" : "One of the files could not be stored", "error");
  } finally {
    hideTransfer();
  }
  $("#fileInput").value = "";
}

function downloadData(data, filename, type = "application/json") {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function prepareScriptsForExport(scripts) {
  const prepared = structuredClone(scripts);
  for (const script of prepared) {
    for (const attachment of script.attachments || []) {
      if (attachment.data) continue;
      const stored = await getAttachmentFile(attachment.id);
      if (stored?.blob) attachment.data = await blobToDataURL(stored.blob);
    }
  }
  return prepared;
}

async function chooseBackupDestination(suggestedName) {
  if (!window.showSaveFilePicker) throw new Error("UNSUPPORTED_BROWSER");
  return window.showSaveFilePicker({
    id: "avaton-streamed-backup",
    suggestedName,
    types: [{ description: "Avaton backup", accept: { "application/octet-stream": [".avaton"] } }],
    excludeAcceptAllOption: true
  });
}

async function writeAttachmentToStream(attachment, writable, onProgress) {
  if (attachment.storage === "disk" && attachment.diskName && state.diskAttachmentsHandle) {
    const handle = await resolveDiskAttachmentHandle(attachment);
    const source = await handle.getFile();
    for (let offset = 0; offset < source.size; offset += DISK_CHUNK_SIZE) {
      const piece = source.slice(offset, Math.min(offset + DISK_CHUNK_SIZE, source.size));
      await writable.write(piece);
      onProgress(piece.size, attachment.name);
    }
    return;
  }
  if (attachment.storage === "chunks" || attachment.chunkCount) {
    const count = attachment.chunkCount || Math.ceil(attachment.size / CHUNK_SIZE);
    for (let index = 0; index < count; index++) {
      const blob = await getFileChunk(attachment.id, index);
      if (!blob) throw new Error(`Missing file piece for ${attachment.name}`);
      await writable.write(blob);
      onProgress(blob.size, attachment.name);
    }
    return;
  }
  const legacy = await getAttachmentFile(attachment.id);
  if (legacy?.blob) {
    for (let offset = 0; offset < legacy.blob.size; offset += CHUNK_SIZE) {
      const piece = legacy.blob.slice(offset, Math.min(offset + CHUNK_SIZE, legacy.blob.size));
      await writable.write(piece);
      onProgress(piece.size, attachment.name);
    }
    return;
  }
  if (attachment.data) {
    const blob = await (await fetch(attachment.data)).blob();
    for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
      const piece = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
      await writable.write(piece);
      onProgress(piece.size, attachment.name);
    }
    return;
  }
  throw new Error(`File data is missing for ${attachment.name}`);
}

async function exportStreamedBackup(scripts, filename) {
  const cleanScripts = structuredClone(scripts).map(script => ({
    ...script,
    attachments: (script.attachments || []).map(({ data, ...attachment }) => attachment)
  }));
  const includedFolderIds = new Set(cleanScripts.map(script => script.folderId).filter(Boolean));
  const folders = scripts.length === state.scripts.length ? state.folders : state.folders.filter(folder => includedFolderIds.has(folder.id));
  const uniqueAttachments = new Map();
  for (const script of cleanScripts) {
    for (const attachment of script.attachments || []) if (!uniqueAttachments.has(attachment.id)) uniqueAttachments.set(attachment.id, attachment);
  }
  const attachments = [...uniqueAttachments.values()];
  const manifest = {
    app: "Avaton",
    version: 8,
    type: scripts.length === state.scripts.length ? "full-backup" : "script-backup",
    exportedAt: new Date().toISOString(),
    folders,
    cells: state.cells,
    stickyNotes: state.stickyNotes,
    files: attachments,
    scripts: cleanScripts
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(BACKUP_MAGIC), 0);
  new DataView(header.buffer).setUint32(8, manifestBytes.length, true);
  const fileBytes = attachments.reduce((sum, file) => sum + file.size, 0);
  const completionBytes = new TextEncoder().encode(BACKUP_COMPLETE_MARKER);
  const totalBytes = header.length + manifestBytes.length + fileBytes + completionBytes.length;
  let handle;
  try {
    handle = await chooseBackupDestination(filename);
  } catch (error) {
    if (error?.name !== "AbortError") {
      toast(error?.message === "UNSUPPORTED_BROWSER"
        ? "Use current Chrome or Edge so Avaton can save to the exact location you choose"
        : "The Save As window was blocked. Allow file saving and try again", "error");
    }
    return;
  }
  try {
    await validateBackupSources(scripts);
  } catch (error) {
    toast(`Backup cannot start: ${error.message}`, "error");
    return;
  }
  let written = 0;
  let writable;
  try {
    showTransfer("Creating portable backup", "The .crswap file is temporary. Keep Avaton open until it disappears and the .avaton file reaches full size.", "STREAMED BACKUP");
    writable = await handle.createWritable();
    await writable.write(header);
    written += header.length;
    await writable.write(manifestBytes);
    written += manifestBytes.length;
    updateTransfer(written, totalBytes);
    for (const attachment of attachments) {
      await writeAttachmentToStream(attachment, writable, (amount, name) => {
        written += amount;
        updateTransfer(written, totalBytes, `Backing up ${name}`);
      });
    }
    await writable.write(completionBytes);
    written += completionBytes.length;
    await writable.close();
    writable = null;
    updateTransfer(totalBytes, totalBytes, "Backup verified and finalized.");
    toast(`Backup saved as ${handle.name}`);
  } catch (error) {
    if (writable) await writable.abort().catch(() => {});
    const message = error?.name === "NotAllowedError"
      ? "Backup permission was blocked. Allow file saving and try again"
      : error?.name === "QuotaExceededError"
        ? "The destination does not have enough free space"
        : `Backup stopped: ${error?.message || "the browser could not write the file"}`;
    toast(message, "error");
  } finally {
    hideTransfer();
  }
}

async function exportEverything() {
  try {
    toast("Choose a destination folder. Avaton will create a normal backup folder with avaton-vault.json and attachments.");
    await createLargeFolderBackup(state.scripts, state.songs);
  } catch {
    toast("The backup could not be created", "error");
  }
}

async function exportOne() {
  const root = state.scripts.find(item => item.id === state.currentScriptId);
  if (!root) return;
  try {
    toast("Choose a destination folder. Avaton will create a normal backup folder for this script.");
    await createLargeFolderBackup([root], []);
  } catch {
    toast("This script backup could not be created", "error");
  }
}

async function importBackup(file, targetFolderId = null, includeCells = true) {
  if (file.name.toLowerCase().endsWith(".crswap")) {
    toast("That is Chrome’s unfinished temporary file. Wait for it to disappear and import the completed .avaton file.", "error");
    clearImportInput();
    return;
  }
  if (!file.size) {
    toast("This backup is empty because its export did not finish. Create the backup again and keep Avaton open until the .crswap file disappears.", "error");
    clearImportInput();
    return;
  }
  const snapshot = await captureImportSnapshot();
  try {
    const signature = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
    if (signature === 0x04034b50) {
      await importZipBackup(file, targetFolderId, includeCells);
      return;
    }
    const magic = new TextDecoder().decode(await file.slice(0, 8).arrayBuffer());
    if (magic === BACKUP_MAGIC) {
      await importStreamedBackup(file, targetFolderId, includeCells);
      return;
    }
    showTransfer("Importing legacy backup", "Reading scripts and embedded files.", "IMPORT");
    const payload = JSON.parse(await file.text());
    if (payload.app !== "Avaton" || !Array.isArray(payload.scripts)) throw new Error("Invalid backup");
    const imported = prepareAdditiveImport(payload, targetFolderId, includeCells);
    const totalImportBytes = payload.scripts.flatMap(script => script.attachments || [])
      .reduce((sum, attachment) => sum + (Number(attachment.size) || 0), 0);
    let importedBytes = 0;
    for (const folder of imported.folders) {
      await putFolder(folder);
      state.folders.push(folder);
    }
    if (imported.cells) {
      mergeImportedCells(imported.cells);
      await putCells();
    }
    for (const script of imported.scripts) {
      if (!script.id || typeof script.title !== "string") continue;
      const clean = {
        id: script.id,
        parentId: script.parentId || null,
        folderId: script.folderId || null,
        title: script.title,
        text: typeof script.text === "string" ? script.text : "",
        color: COLORS.includes(script.color) ? script.color : COLORS[0],
        attachments: [],
        createdAt: script.createdAt || new Date().toISOString(),
        updatedAt: script.updatedAt || new Date().toISOString(),
        lastOpenedAt: script.lastOpenedAt || script.updatedAt || new Date().toISOString()
      };
      for (const attachment of Array.isArray(script.attachments) ? script.attachments : []) {
        const descriptor = { id: attachment.id || uid(), name: attachment.name || "Imported file", type: attachment.type || "", size: attachment.size || 0 };
        if (typeof attachment.data === "string") {
          const blob = await (await fetch(attachment.data)).blob();
          descriptor.size = descriptor.size || blob.size;
          descriptor.type = descriptor.type || blob.type;
          await storeImportedBlob(descriptor, blob, amount => {
            importedBytes += amount;
            updateTransfer(importedBytes, Math.max(totalImportBytes, importedBytes, 1), `Saving ${descriptor.name}`);
          });
        }
        clean.attachments.push(descriptor);
      }
      await putScript(clean);
      state.scripts.push(clean);
    }
    renderAll();
    await updateStorageEstimate();
    openFolder(targetFolderId);
    toast(`${imported.scripts.length} script${imported.scripts.length === 1 ? "" : "s"} imported as new data`);
  } catch {
    await rollbackImport(snapshot);
    toast("That file is not a complete Avaton backup. Current data was not changed.", "error");
  }
  hideTransfer();
  clearImportInput();
}

async function importStreamedBackup(file, targetFolderId = null, includeCells = true) {
  const snapshot = await captureImportSnapshot();
  showTransfer("Restoring Avaton", "Reading the backup in small pieces. Keep the drive connected.", "FULL RESTORE");
  try {
    if (file.size < 12) throw new Error("Backup header is incomplete");
    const header = await file.slice(0, 12).arrayBuffer();
    const manifestLength = new DataView(header).getUint32(8, true);
    const manifestStart = 12;
    const manifestEnd = manifestStart + manifestLength;
    const manifest = JSON.parse(new TextDecoder().decode(await file.slice(manifestStart, manifestEnd).arrayBuffer()));
    if (manifest.app !== "Avaton" || !Array.isArray(manifest.scripts)) throw new Error("Invalid backup");
    const attachments = Array.isArray(manifest.files)
      ? manifest.files
      : manifest.scripts.flatMap(script => script.attachments || []);
    const dataEnd = manifestEnd + attachments.reduce((sum, item) => sum + item.size, 0);
    const markerBytes = new TextEncoder().encode(BACKUP_COMPLETE_MARKER);
    const expectedSize = dataEnd + (manifest.version >= 8 ? markerBytes.length : 0);
    if (file.size < expectedSize) throw new Error("Backup export did not finish");
    if (manifest.version >= 8) {
      const marker = new TextDecoder().decode(await file.slice(dataEnd, expectedSize).arrayBuffer());
      if (marker !== BACKUP_COMPLETE_MARKER) throw new Error("Backup completion marker is missing");
    }
    const imported = prepareAdditiveImport(manifest, targetFolderId, includeCells);
    for (const folder of imported.folders) {
      await putFolder(folder);
      state.folders.push(folder);
    }
    if (imported.cells) { mergeImportedCells(imported.cells); await putCells(); }
    for (const note of manifest.stickyNotes || []) {
      const importedNote = { ...note, id: uid(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.stickyNotes.push(importedNote);
      await putStickyNote(importedNote);
    }
    let offset = manifestEnd;
    let restored = manifestEnd;
    for (const sourceAttachment of attachments) {
      const matching = imported.scripts.flatMap(script => script.attachments || [])
        .filter(attachment => attachment.originalId === sourceAttachment.id);
      const target = matching[0];
      if (!target) {
        offset += sourceAttachment.size;
        restored += sourceAttachment.size;
        continue;
      }
      const source = file.slice(offset, offset + sourceAttachment.size, sourceAttachment.type || "application/octet-stream");
      await storeImportedBlob(target, source, amount => {
        restored += amount;
        updateTransfer(restored, expectedSize, `Restoring ${sourceAttachment.name}`);
      });
      offset += sourceAttachment.size;
      for (const duplicate of matching.slice(1)) {
        duplicate.size = target.size;
        duplicate.type = target.type;
        duplicate.storage = target.storage;
        duplicate.diskName = target.diskName;
        duplicate.chunkCount = target.chunkCount;
      }
    }
    for (const script of imported.scripts) {
      for (const attachment of script.attachments || []) {
        delete attachment.originalId;
      }
      await putScript(script);
      state.scripts.push(script);
    }
    renderAll();
    openFolder(targetFolderId);
    await updateStorageEstimate();
    toast(`${imported.scripts.length} script${imported.scripts.length === 1 ? "" : "s"} imported without changing previous data`);
  } catch (error) {
    await rollbackImport(snapshot);
    toast(`Restore failed safely: ${error.message}. Current data was not changed.`, "error");
  } finally {
    hideTransfer();
    clearImportInput();
  }
}

async function deleteCurrentScript() {
  const script = state.scripts.find(item => item.id === state.currentScriptId);
  if (!script) return;
  const family = [script];
  if (!confirm(`Delete “${script.title}”? This cannot be undone.`)) return;
  for (const item of family) {
    for (const attachment of item.attachments || []) {
      await removeDiskAttachment(attachment);
      await removeFileChunks(attachment.id);
      await removeAttachmentFile(attachment.id);
    }
    await removeScriptRecord(item.id);
  }
  const ids = new Set(family.map(item => item.id));
  state.scripts = state.scripts.filter(item => !ids.has(item.id));
  state.currentScriptId = null;
  renderAll();
  await updateStorageEstimate();
  showView("scripts");
  toast("Script deleted");
}

function bindEvents() {
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const submitButton = $("#loginForm button[type='submit']");
    submitButton.disabled = true;
    submitButton.textContent = "Checking…";
    if (await verifyPassword($("#passwordInput").value)) unlock();
    else {
      $("#loginError").textContent = "That password does not match. Check capitalization.";
      $("#passwordInput").select();
    }
    submitButton.disabled = false;
    submitButton.innerHTML = `Enter Avaton <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  });
  $("#showPasswordHint").addEventListener("click", () => $("#passwordHint").classList.toggle("hidden"));
  $("#passwordToggle").addEventListener("click", () => {
    const input = $("#passwordInput");
    input.type = input.type === "password" ? "text" : "password";
  });
  $("#lockButton").addEventListener("click", lock);
  const closeSecurityModal = () => {
    $("#securityModal").classList.add("hidden");
    $("#changePasswordForm").reset();
    $("#securityError").textContent = "";
  };
  $("#securityButton").addEventListener("click", () => {
    $("#changePasswordForm").reset();
    $("#newPasswordHint").value = localStorage.getItem(PASSWORD_HINT_KEY) || "";
    $("#securityError").textContent = "";
    $("#securityModal").classList.remove("hidden");
    setTimeout(() => $("#currentPassword").focus(), 50);
  });
  $("#securityModalClose").addEventListener("click", closeSecurityModal);
  $("#securityModalCancel").addEventListener("click", closeSecurityModal);
  $("#securityModal").addEventListener("click", event => { if (event.target === $("#securityModal")) closeSecurityModal(); });
  $("#changePasswordForm").addEventListener("submit", async event => {
    event.preventDefault();
    const current = $("#currentPassword").value;
    const next = $("#newPassword").value;
    const confirmation = $("#confirmPassword").value;
    const error = $("#securityError");
    error.textContent = "";
    if (!await verifyPassword(current)) {
      error.textContent = "Current password is incorrect.";
      $("#currentPassword").focus();
      return;
    }
    if (next.length < 4) {
      error.textContent = "New password must contain at least 4 characters.";
      return;
    }
    if (next !== confirmation) {
      error.textContent = "The new passwords do not match.";
      return;
    }
    if (next === current) {
      error.textContent = "Choose a password different from the current one.";
      return;
    }
    const button = $("#changePasswordForm button[type='submit']");
    button.disabled = true;
    button.textContent = "Updating…";
    await savePassword(next, $("#newPasswordHint").value);
    button.disabled = false;
    button.textContent = "Update password";
    closeSecurityModal();
    toast("Password and hint updated");
  });
  $("#themeToggle").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  $("#menuButton").addEventListener("click", openSidebar);
  $("#mobileClose").addEventListener("click", closeSidebar);
  $("#sidebarOverlay").addEventListener("click", closeSidebar);

  document.addEventListener("click", event => {
    const openButton = event.target.closest("[data-open-script]");
    if (openButton) openEditor(openButton.dataset.openScript);
    const folderButton = event.target.closest("[data-open-folder]");
    if (folderButton) openFolder(folderButton.dataset.openFolder);
    const viewButton = event.target.closest("[data-go-view]");
    if (viewButton) showView(viewButton.dataset.goView);
  });
  $$(".nav-item").forEach(button => button.addEventListener("click", () => {
    if (button.dataset.view === "scripts") openFolder(null);
    else showView(button.dataset.view);
  }));

  ["#createRootButton", "#homeCreateButton", "#libraryCreateButton", "#emptyCreateButton"].forEach(selector => $(selector).addEventListener("click", () => openCreateModal()));
  $("#createFolderButton").addEventListener("click", () => {
    $("#newFolderTitle").value = "";
    $("#folderModal").classList.remove("hidden");
    setTimeout(() => $("#newFolderTitle").focus(), 50);
  });
  const closeFolderModal = () => $("#folderModal").classList.add("hidden");
  $("#folderModalClose").addEventListener("click", closeFolderModal);
  $("#folderModalCancel").addEventListener("click", closeFolderModal);
  $("#folderModal").addEventListener("click", event => { if (event.target === $("#folderModal")) closeFolderModal(); });
  $("#createFolderForm").addEventListener("submit", async event => {
    event.preventDefault();
    const title = $("#newFolderTitle").value;
    closeFolderModal();
    await createFolder(title);
  });
  $("#moveCurrentFolderButton").addEventListener("click", () => openMoveFolderModal(state.currentFolderId));
  $("#renameCurrentFolderButton").addEventListener("click", () => openRenameModal("folder", state.currentFolderId));
  $("#deleteCurrentFolderButton").addEventListener("click", deleteCurrentFolder);
  $("#moveFolderModalClose").addEventListener("click", closeMoveFolderModal);
  $("#moveFolderModalCancel").addEventListener("click", closeMoveFolderModal);
  $("#moveFolderModal").addEventListener("click", event => { if (event.target === $("#moveFolderModal")) closeMoveFolderModal(); });
  $("#moveFolderForm").addEventListener("submit", async event => {
    event.preventDefault();
    const folder = state.folders.find(item => item.id === $("#moveFolderModal").dataset.folderId);
    if (!folder) return;
    folder.parentId = $("#moveFolderSelect").value || null;
    folder.updatedAt = new Date().toISOString();
    await putFolder(folder);
    closeMoveFolderModal();
    renderAll();
    openFolder(folder.id);
    toast("Folder moved inside the selected folder");
  });
  $("#modalClose").addEventListener("click", closeCreateModal);
  $("#modalCancel").addEventListener("click", closeCreateModal);
  $("#scriptModal").addEventListener("click", event => { if (event.target === $("#scriptModal")) closeCreateModal(); });
  $("#colorChoices").addEventListener("click", event => {
    const choice = event.target.closest("[data-color]");
    if (!choice) return;
    state.chosenColor = choice.dataset.color;
    renderColors();
  });
  $("#createScriptForm").addEventListener("submit", async event => {
    event.preventDefault();
    const title = $("#newScriptTitle").value;
    const parentId = state.pendingParentId;
    closeCreateModal();
    await createScript(title, parentId);
  });

  $("#editorTitle").addEventListener("input", queueEditorSave);
  $("#renameScriptButton").addEventListener("click", () => openRenameModal("script", state.currentScriptId));
  $("#editorText").addEventListener("input", queueEditorSave);
  $("#renameModalClose").addEventListener("click", closeRenameModal);
  $("#renameModalCancel").addEventListener("click", closeRenameModal);
  $("#renameModal").addEventListener("click", event => { if (event.target === $("#renameModal")) closeRenameModal(); });
  $("#renameForm").addEventListener("submit", async event => {
    event.preventDefault();
    const type = $("#renameModal").dataset.type;
    const id = $("#renameModal").dataset.id;
    const value = $("#renameValue").value.trim();
    if (!value) return;
    const item = type === "folder"
      ? state.folders.find(folder => folder.id === id)
      : state.scripts.find(script => script.id === id);
    if (!item) return closeRenameModal();
    item.title = value;
    item.updatedAt = new Date().toISOString();
    if (type === "folder") await putFolder(item);
    else await putScript(item);
    closeRenameModal();
    renderAll();
    toast(`${type === "folder" ? "Folder" : "Script"} renamed`);
  });
  $("#scriptFolderSelect").addEventListener("change", async event => {
    const script = state.scripts.find(item => item.id === state.currentScriptId);
    if (!script) return;
    script.folderId = event.target.value || null;
    script.updatedAt = new Date().toISOString();
    await putScript(script);
    renderAll();
    toast("Script moved");
  });
  $("#fileInput").addEventListener("change", event => handleFiles(event.target.files));
  $("#songInput").addEventListener("change", event => uploadSongs(event.target.files));
  $("#songPlayer").addEventListener("ended", playNextSong);
  $("#songPlayer").addEventListener("play", renderDashboardPlayer);
  $("#songPlayer").addEventListener("pause", renderDashboardPlayer);
  $("#songPlayer").addEventListener("timeupdate", updateDashboardSeek);
  $("#songPlayer").addEventListener("loadedmetadata", updateDashboardSeek);
  $("#songPlayer").volume = Number($("#dashboardVolume").value || 100) / 100;
  $("#dashboardPlayPause").addEventListener("click", async () => {
    const player = $("#songPlayer");
    if (!player.dataset.songId) return;
    if (player.paused) await player.play();
    else player.pause();
    renderDashboardPlayer();
  });
  $("#dashboardPrevSong").addEventListener("click", playPreviousSong);
  $("#dashboardNextSong").addEventListener("click", playNextSong);
  $("#dashboardRepeatSong").addEventListener("click", () => {
    const player = $("#songPlayer");
    const currentId = player.dataset.songId;
    if (!currentId) return;
    player.dataset.repeatSongId = player.dataset.repeatSongId === currentId ? "" : currentId;
    renderSongs();
  });
  $("#dashboardVolume").addEventListener("input", event => {
    $("#songPlayer").volume = Number(event.target.value) / 100;
  });
  $("#dashboardSeek").addEventListener("input", event => {
    const player = $("#songPlayer");
    if (!player.dataset.songId) return;
    player.currentTime = Number(event.target.value) || 0;
    updateDashboardSeek();
  });
  $("#repeatSongButton").addEventListener("click", () => {
    const player = $("#songPlayer");
    const currentId = player.dataset.songId;
    if (!currentId) return toast("Play a song first, then turn repeat on");
    player.dataset.repeatSongId = player.dataset.repeatSongId === currentId ? "" : currentId;
    renderSongs();
  });
  $("#songList").addEventListener("click", async event => {
    const play = event.target.closest("[data-play-song]");
    const repeat = event.target.closest("[data-repeat-one]");
    const remove = event.target.closest("[data-delete-song]");
    if (play) await playSong(play.dataset.playSong);
    if (repeat) {
      $("#songPlayer").dataset.repeatSongId = repeat.dataset.repeatOne;
      await playSong(repeat.dataset.repeatOne);
    }
    if (remove) {
      const song = state.songs.find(item => item.id === remove.dataset.deleteSong);
      if (!song || !confirm(`Delete “${song.name}” from Song Player?`)) return;
      if ($("#songPlayer").dataset.songId === song.id) {
        $("#songPlayer").pause();
        $("#songPlayer").removeAttribute("src");
        $("#songPlayer").dataset.songId = "";
        $("#songPlayer").dataset.repeatSongId = "";
      }
      await removeDiskAttachment(song);
      state.songs = state.songs.filter(item => item.id !== song.id);
      await putSongs();
      renderSongs();
      renderDashboardPlayer();
      await updateStorageEstimate();
      toast("Song deleted");
    }
  });
  $("#songList").addEventListener("input", event => {
    const input = event.target.closest("[data-song-priority]");
    if (!input) return;
    const song = state.songs.find(item => item.id === input.dataset.songPriority);
    if (!song) return;
    song.priority = Math.max(1, Number(input.value) || 1);
    clearTimeout(prioritySaveTimer);
    prioritySaveTimer = setTimeout(async () => {
      await putSongs();
      renderSongs();
    }, 350);
  });
  $("#attachmentList").addEventListener("click", async event => {
    const preview = event.target.closest("[data-preview-file]");
    const download = event.target.closest("[data-download-file]");
    const remove = event.target.closest("[data-remove-file]");
    if (preview) {
      const { file } = findAttachmentById(preview.dataset.previewFile);
      if (file) await previewAttachment(file);
      else toast("This file is missing from the script list", "error");
    }
    if (download) {
      const { file } = findAttachmentById(download.dataset.downloadFile);
      if (file) {
        const downloadName = ensureFilename(file.name, file.type);
        if (file.storage === "disk") {
          try {
            const blob = await getAttachmentBlob(file);
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = downloadName;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch {
            toast("Reconnect the Disk Vault folder to access this file", "error");
          }
          return;
        }
        if (file.storage === "chunks" && window.showSaveFilePicker) {
          try {
            const handle = await window.showSaveFilePicker({ suggestedName: downloadName });
            const writable = await handle.createWritable();
            showTransfer("Saving attachment", `Writing ${file.name} without loading it all into memory.`, "FILE DOWNLOAD");
            let saved = 0;
            for (let index = 0; index < file.chunkCount; index++) {
              const chunk = await getFileChunk(file.id, index);
              await writable.write(chunk);
              saved += chunk.size;
              updateTransfer(saved, file.size, `Saving ${file.name}`);
            }
            await writable.close();
            hideTransfer();
            toast("File saved");
          } catch (error) {
            hideTransfer();
            if (error?.name !== "AbortError") toast("The file could not be saved", "error");
          }
          return;
        }
        const stored = await getAttachmentFile(file.id);
        const anchor = document.createElement("a");
        const objectUrl = stored?.blob ? URL.createObjectURL(stored.blob) : file.data;
        anchor.href = objectUrl;
        anchor.download = downloadName;
        anchor.click();
        if (stored?.blob) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
    }
    if (remove) {
      const { script } = findAttachmentById(remove.dataset.removeFile);
      if (!script) {
        toast("This file is missing from the script list", "error");
        return;
      }
      const removingFile = script.attachments.find(item => item.id === remove.dataset.removeFile);
      if (removingFile) await removeDiskAttachment(removingFile);
      await removeFileChunks(remove.dataset.removeFile);
      await removeAttachmentFile(remove.dataset.removeFile);
      script.attachments = script.attachments.filter(item => item.id !== remove.dataset.removeFile);
      script.updatedAt = new Date().toISOString();
      await putScript(script);
      renderAttachments(script);
      await updateStorageEstimate();
      toast("Attachment removed");
    }
  });
  $("#viewerClose").addEventListener("click", closeViewer);
  $("#viewerModal").addEventListener("click", event => { if (event.target === $("#viewerModal")) closeViewer(); });
  $("#addStickyNoteButton").addEventListener("click", async () => {
    if (!requireDiskVault()) return;
    const note = { id: uid(), text: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    state.stickyNotes.unshift(note);
    await putStickyNote(note);
    renderStickyNotes();
    $("#stickyNotes textarea")?.focus();
  });
  let stickySaveTimer;
  $("#stickyNotes").addEventListener("input", event => {
    const input = event.target.closest("[data-sticky-id]");
    if (!input) return;
    const note = state.stickyNotes.find(item => item.id === input.dataset.stickyId);
    if (!note) return;
    note.text = input.value;
    note.updatedAt = new Date().toISOString();
    clearTimeout(stickySaveTimer);
    stickySaveTimer = setTimeout(() => putStickyNote(note), 350);
  });
  $("#stickyNotes").addEventListener("click", async event => {
    const button = event.target.closest("[data-delete-sticky]");
    if (!button) return;
    state.stickyNotes = state.stickyNotes.filter(note => note.id !== button.dataset.deleteSticky);
    await removeStickyNote(button.dataset.deleteSticky);
    renderStickyNotes();
  });
  $("#addCellColumnButton").addEventListener("click", () => {
    $("#newColumnName").value = "";
    $("#columnModal").classList.remove("hidden");
  });
  const closeColumnModal = () => $("#columnModal").classList.add("hidden");
  $("#columnModalClose").addEventListener("click", closeColumnModal);
  $("#columnModalCancel").addEventListener("click", closeColumnModal);
  $("#createColumnForm").addEventListener("submit", async event => {
    event.preventDefault();
    getActiveSheet().columns.push({ id: uid(), name: $("#newColumnName").value.trim(), type: $("#newColumnType").value });
    await putCells();
    closeColumnModal();
    renderCells();
  });
  $("#addCellRowButton").addEventListener("click", async () => {
    getActiveSheet().rows.push({ id: uid(), values: {} });
    await putCells();
    renderCells();
  });
  $("#cellsTable").addEventListener("input", async event => {
    const columnName = event.target.closest("[data-column-name]");
    if (columnName) {
      const column = getActiveSheet().columns.find(item => item.id === columnName.dataset.columnName);
      if (column) { column.name = columnName.value; await putCells(); }
      return;
    }
    const input = event.target.closest("[data-cell-row]");
    if (!input) return;
    const row = getActiveSheet().rows.find(item => item.id === input.dataset.cellRow);
    if (!row) return;
    row.values[input.dataset.cellColumn] = input.type === "checkbox" ? input.checked : input.value;
    selectSheetCell(Number(input.dataset.cellRowIndex), Number(input.dataset.cellColumnIndex));
    await putCells();
  });
  $("#cellsTable").addEventListener("click", event => {
    const cell = event.target.closest("[data-cell-row-index][data-cell-column-index]");
    if (cell) selectSheetCell(Number(cell.dataset.cellRowIndex), Number(cell.dataset.cellColumnIndex));
  });
  $("#cellsTable").addEventListener("keydown", event => {
    const input = event.target.closest("[data-cell-row-index][data-cell-column-index]");
    if (!input) return;
    const row = Number(input.dataset.cellRowIndex), column = Number(input.dataset.cellColumnIndex);
    const movement = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Enter: [1, 0], Tab: [0, event.shiftKey ? -1 : 1] }[event.key];
    if (!movement || (!["Enter", "Tab"].includes(event.key) && input.selectionStart !== input.selectionEnd)) return;
    if (["Enter", "Tab"].includes(event.key) || input.type === "checkbox") {
      event.preventDefault();
      selectSheetCell(row + movement[0], column + movement[1], true);
    }
  });
  $("#cellsTable").addEventListener("paste", async event => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text || (!text.includes("\t") && !text.includes("\n"))) return;
    event.preventDefault();
    await pasteSpreadsheet(text);
  });
  $("#formulaInput").addEventListener("change", async event => {
    const column = getActiveCell().column;
    const value = column.type === "checkbox" ? /^(true|yes|1|x|✓)$/i.test(event.target.value.trim()) : event.target.value;
    await setCellValue(state.activeCell.row, state.activeCell.column, value);
    renderCells();
  });
  $("#activeCellType").addEventListener("change", async event => {
    const { column } = getActiveCell();
    column.type = event.target.value;
    await putCells();
    renderCells();
  });
  $("#sheetNameInput").addEventListener("change", async event => {
    getActiveSheet().name = event.target.value.trim() || "Untitled Sheet";
    await putCells();
    renderCells();
  });
  $("#deleteCellRowButton").addEventListener("click", async () => {
    const sheet = getActiveSheet();
    if (sheet.rows.length <= 1) return toast("A sheet must keep at least one row", "error");
    sheet.rows.splice(state.activeCell.row, 1);
    state.activeCell.row = Math.max(0, state.activeCell.row - 1);
    await putCells(); renderCells();
  });
  $("#deleteCellColumnButton").addEventListener("click", async () => {
    const sheet = getActiveSheet();
    if (sheet.columns.length <= 1) return toast("A sheet must keep at least one column", "error");
    const [column] = sheet.columns.splice(state.activeCell.column, 1);
    sheet.rows.forEach(row => { if (row.values) delete row.values[column.id]; });
    state.activeCell.column = Math.max(0, state.activeCell.column - 1);
    await putCells(); renderCells();
  });
  $("#clearCellButton").addEventListener("click", async () => {
    await setCellValue(state.activeCell.row, state.activeCell.column, "");
    renderCells();
  });
  $("#addSheetButton").addEventListener("click", async () => {
    const sheet = makeSheet(`Sheet ${state.cells.sheets.length + 1}`);
    state.cells.sheets.push(sheet); state.cells.activeSheetId = sheet.id; state.activeCell = { row: 0, column: 0 };
    await putCells(); renderCells();
  });
  $("#sheetTabList").addEventListener("click", async event => {
    const tab = event.target.closest("[data-sheet-id]");
    if (!tab) return;
    state.cells.activeSheetId = tab.dataset.sheetId; state.activeCell = { row: 0, column: 0 };
    await putCells(); renderCells();
  });
  $("#deleteSheetButton").addEventListener("click", async () => {
    if (state.cells.sheets.length <= 1) return toast("A workbook must keep at least one sheet", "error");
    if (!confirm(`Delete “${getActiveSheet().name}”?`)) return;
    state.cells.sheets = state.cells.sheets.filter(sheet => sheet.id !== state.cells.activeSheetId);
    state.cells.activeSheetId = state.cells.sheets[0].id; state.activeCell = { row: 0, column: 0 };
    await putCells(); renderCells();
  });
  $("#deleteScriptButton").addEventListener("click", deleteCurrentScript);
  $("#exportOneButton").addEventListener("click", exportOne);
  $("#exportAllButton").addEventListener("click", exportEverything);
  $("#quickBackupButton").addEventListener("click", exportEverything);
  $("#restoreFolderBackupButton").addEventListener("click", restoreLargeFolderBackup);
  $("#connectDiskVaultButton").addEventListener("click", () => connectDiskVault(true));
  $("#chooseRequiredDiskVault").addEventListener("click", () => connectDiskVault(false));
  $("#syncDiskVaultButton").addEventListener("click", async () => {
    try { await syncDiskVault(); toast("Disk Vault saved"); }
    catch { toast("Disk save failed — reconnect the folder", "error"); }
  });
  $("#createFolderBackupButton").addEventListener("click", createLargeFolderBackup);
  $("#transferCancel").addEventListener("click", () => {
    if (transferState.mode !== "upload") return;
    transferState.cancelled = true;
    $("#transferCancel").disabled = true;
    $("#transferCancel").textContent = "Cancelling…";
    $("#transferDetail").textContent = "Finishing the current piece, then removing partial data.";
  });

  $("#prevYear").addEventListener("click", () => { state.calendarYear--; renderCalendar(); });
  $("#nextYear").addEventListener("click", () => { state.calendarYear++; renderCalendar(); });
  $("#defaultYearButton").addEventListener("click", () => { state.calendarYear = 2026; state.calendarMonth = 0; renderCalendar(); });
  $("#monthTabs").addEventListener("click", event => {
    const button = event.target.closest("[data-month]");
    if (!button) return;
    state.calendarMonth = Number(button.dataset.month);
    renderCalendar();
  });
  $("#calendarGrid").addEventListener("click", event => {
    const date = event.target.closest("[data-date]");
    if (date) selectCalendarDate(date.dataset.date);
  });
  $("#searchInput").addEventListener("input", event => {
    state.search = event.target.value.trim();
    renderScriptGrid();
    renderFolders();
    if (state.search) showView("scripts");
  });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#searchInput").focus();
    }
    if (event.key === "Escape") closeCreateModal();
  });
}

async function init() {
  applyTheme(localStorage.getItem("avaton-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const now = new Date();
  const hour = now.getHours();
  $("#greeting").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}.`;
  $("#todayChip").textContent = formatDate(now, { weekday: "short", month: "short", day: "numeric" });
  await initializePassword();
  bindEvents();
  try {
    state.db = await openDatabase();
    [state.scripts, state.folders, state.cells, state.stickyNotes] = await Promise.all([getAllScripts(), getAllFolders(), getCells(), getStickyNotes()]);
    await flattenNestedScripts();
    state.rememberedDiskVaultHandle = await getSetting(DISK_HANDLE_KEY);
    if (state.rememberedDiskVaultHandle) await restoreRememberedDiskVault(false);
  } catch {
    toast("Older Avaton data could not be checked for migration", "error");
  }
  renderAll();
  updateStorageEstimate();
  if (sessionStorage.getItem("avaton-unlocked") === "true") unlock();
}

init();

