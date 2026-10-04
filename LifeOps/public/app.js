const byId = (id) => document.getElementById(id);
const chatContent = byId("chat-content");
const eventLog = byId("event-log");
const messageInput = byId("message-input");
const sendButton = byId("send-button");
const rehearsalButton = byId("rehearsal-button");
const speakButton = byId("speak-button");
const themeToggle = byId("theme-toggle");
const maxContextMessages = 32;
const liveMessages = [];
const browserClientId = crypto.randomUUID();
const runEvidence = [];
const localTasksKey = "lifeops-tasks-v1";
const localSettingsKey = "lifeops-settings-v1";
const settingsActivityKey = "lifeops-settings-activity-v1";
let configuration = null;
let currentUser = null;
let tasks = [];
let conversationId = localStorage.getItem("lifeops-conversation-id") || crypto.randomUUID();
let authMode = "login";
let messageSource = "chat";
let lastReply = "";
let requestInProgress = false;
let toastTimer;
let runMode = "not-started";
let voiceInputAvailable = false;
let gnaniAudioUrl;
const pineStatusByRequestId = new Map();
try {
  const savedPineStatuses = JSON.parse(localStorage.getItem("lifeops-pine-statuses") || "[]");
  if (Array.isArray(savedPineStatuses)) {
    for (const [id, status] of savedPineStatuses) {
      if (typeof id === "string" && typeof status === "string") pineStatusByRequestId.set(id, status);
    }
  }
} catch (error) {
  console.warn("Could not load cached Pine Labs status:", error);
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeToggle.textContent = isDark ? "Light" : "Dark";
  themeToggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
  document.querySelector('meta[name="theme-color"]').content = isDark ? "#141a16" : "#f8f9f7";
}

function showWorkspaceView(name) {
  for (const button of document.querySelectorAll(".workspace-tab")) {
    const selected = button.dataset.view === name;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
  }
  for (const view of document.querySelectorAll(".workspace-view")) view.hidden = view.id !== `view-${name}`;
  if (name === "approvals" && currentUser) refreshApprovalData().catch((error) => showToast(error.message));
  if (name === "activity" && currentUser) loadActivityHistory().catch((error) => showToast(error.message));
  if (name === "settings") loadSettings().catch((error) => showToast(error.message));
}

function saveSettingsActivity(message) {
  let entries = [];
  try {
    entries = JSON.parse(localStorage.getItem(settingsActivityKey) || "[]");
  } catch {}
  entries.unshift({ at: new Date().toISOString(), message });
  localStorage.setItem(settingsActivityKey, JSON.stringify(entries.slice(0, 30)));
  renderSettingsActivity();
}

function renderSettingsActivity() {
  const list = byId("settings-activity-list");
  let entries = [];
  try {
    entries = JSON.parse(localStorage.getItem(settingsActivityKey) || "[]");
  } catch {}
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("li");
    empty.textContent = "No settings changes recorded on this device.";
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("li");
    item.textContent = `${new Date(entry.at).toLocaleString("en-IN")}: ${entry.message}`;
    list.append(item);
  }
}

function sendBrowserHeartbeat() {
  fetch("/api/lifecycle/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: browserClientId }),
    keepalive: true,
  }).catch(() => {});
}

function disconnectBrowser() {
  const payload = new Blob([JSON.stringify({ clientId: browserClientId })], { type: "application/json" });
  navigator.sendBeacon("/api/lifecycle/disconnect", payload);
}

sendBrowserHeartbeat();
const browserHeartbeatTimer = setInterval(sendBrowserHeartbeat, 5000);
window.addEventListener("pagehide", () => {
  clearInterval(browserHeartbeatTimer);
  disconnectBrowser();
});
window.addEventListener("pageshow", sendBrowserHeartbeat);


function initializeTheme() {
  const savedTheme = localStorage.getItem("lifeops-theme");
  let settingsTheme = "system";
  try {
    settingsTheme = JSON.parse(localStorage.getItem(localSettingsKey) || "{}").theme || "system";
  } catch {}
  const preference = savedTheme || settingsTheme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(preference === "system" ? (prefersDark ? "dark" : "light") : preference);
}

themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("lifeops-theme", nextTheme);
  byId("settings-theme").value = nextTheme;
  applyTheme(nextTheme);
});

function indiaTimestamp(date = new Date()) {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}+05:30`;
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

function appendLiveMessage(message) {
  liveMessages.push(message);
  if (liveMessages.length > maxContextMessages) {
    liveMessages.splice(0, liveMessages.length - maxContextMessages);
  }
}

function normalizeTask(task) {
  return {
    id: task.id || crypto.randomUUID(),
    title: task.title,
    notes: task.notes || "",
    dueAt: task.dueAt || task.due_at || null,
    status: task.status || "open",
    createdVia: task.createdVia || task.created_via || "manual",
    conversationId: task.conversationId || task.conversation_id || null,
    requiresPayment: Boolean(task.requiresPayment ?? task.requires_payment),
    amountPaise: task.amountPaise ?? task.amount_paise ?? null,
    paymentMethod: task.paymentMethod || task.payment_method || null,
    paymentStatus: task.paymentStatus || null,
  };
}

function localTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(localTasksKey) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch (error) {
    console.error("Could not load saved local tasks:", error);
    return [];
  }
}

function saveLocalTasks() {
  localStorage.setItem(localTasksKey, JSON.stringify(tasks));
}

function renderTasks() {
  const list = byId("task-list");
  list.replaceChildren();
  byId("task-count").textContent = String(tasks.filter((task) => task.status !== "cancelled").length);
  byId("tab-task-count").textContent = String(tasks.filter((task) => task.status !== "cancelled").length);
  byId("task-empty").hidden = tasks.length > 0;
  byId("task-storage-note").textContent = currentUser
    ? "Tasks are synced to your Supabase account. Due dates are saved; reminders are not sent."
    : "Tasks stay on this device until you sign in and connect Supabase. No reminders are sent.";
  for (const task of tasks.filter((item) => item.status !== "cancelled")) {
    const card = document.createElement("article");
    card.className = "task-card";
    const heading = document.createElement("div");
    heading.className = "task-card-top";
    const source = document.createElement("span");
    source.className = "task-subject";
    source.textContent = task.createdVia === "voice" ? "VOICE" : task.createdVia === "chat" ? "CHAT" : "TASK";
    const status = document.createElement("span");
    status.className = "task-subject";
    status.textContent = task.status === "done" ? "DONE" : task.requiresPayment ? "PAYMENT" : "OPEN";
    heading.append(source, status);
    const title = document.createElement("h5");
    title.textContent = task.title;
    const due = document.createElement("p");
    due.textContent = task.dueAt ? `Due ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(task.dueAt))}` : "No due date";
    card.append(heading, title, due);
    if (task.notes) {
      const notes = document.createElement("p");
      notes.textContent = task.notes;
      card.append(notes);
    }
    const actions = document.createElement("div");
    actions.className = "task-card-actions";
    const edit = document.createElement("details");
    edit.className = "task-edit";
    const editSummary = document.createElement("summary");
    editSummary.textContent = "Edit";
    const editForm = document.createElement("form");
    editForm.className = "task-edit-form";
    const titleInput = document.createElement("input");
    titleInput.required = true;
    titleInput.maxLength = 180;
    titleInput.value = task.title;
    titleInput.setAttribute("aria-label", "Task title");
    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.value = task.dueAt ? task.dueAt.slice(0, 10) : "";
    dueInput.setAttribute("aria-label", "Due date");
    const notesInput = document.createElement("input");
    notesInput.maxLength = 2000;
    notesInput.value = task.notes || "";
    notesInput.setAttribute("aria-label", "Task notes");
    const statusSelect = document.createElement("select");
    statusSelect.setAttribute("aria-label", "Task status");
    for (const value of ["open", "in_progress", "done", "cancelled"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.replace("_", " ");
      option.selected = task.status === value;
      statusSelect.append(option);
    }
    const saveEdit = document.createElement("button");
    saveEdit.type = "submit";
    saveEdit.textContent = "Save changes";
    editForm.append(titleInput, dueInput, notesInput, statusSelect, saveEdit);
    editForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await updateTask(task.id, {
        title: titleInput.value.trim(),
        dueAt: dueInput.value ? `${dueInput.value}T23:59:00+05:30` : null,
        notes: notesInput.value.trim(),
        status: statusSelect.value,
      });
      edit.open = false;
    });
    edit.append(editSummary, editForm);
    actions.append(edit);
    if (task.status !== "done") {
      const complete = document.createElement("button");
      complete.type = "button";
      complete.textContent = "Mark done";
      complete.addEventListener("click", () => updateTask(task.id, { status: "done" }));
      actions.append(complete);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => deleteTask(task.id));
    actions.append(remove);
    if (task.requiresPayment && task.status !== "done") {
      const payment = document.createElement("button");
      payment.type = "button";
      payment.textContent = task.amountPaise ? `Request guardian approval · ₹${(task.amountPaise / 100).toFixed(2)}` : "Set amount in task details";
      payment.disabled = !task.amountPaise || task.paymentStatus === "awaiting_guardian";
      payment.addEventListener("click", () => requestTaskPayment(task));
      actions.append(payment);
    }
    card.append(actions);
    list.append(card);
  }
}

async function persistTask(task) {
  const normalized = normalizeTask(task);
  if (currentUser) {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not save task to your account.");
    const saved = normalizeTask(data.task);
    tasks.push(saved);
    renderTasks();
    return saved;
  }
  tasks.push(normalized);
  saveLocalTasks();
  renderTasks();
  return normalized;
}

async function updateTask(id, changes) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return false;
  try {
    if (currentUser) {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update task.");
      tasks[index] = normalizeTask(data.task);
    } else {
      tasks[index] = { ...tasks[index], ...changes };
      saveLocalTasks();
    }
    renderTasks();
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function deleteTask(id) {
  try {
    if (currentUser) {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not remove task.");
    }
    tasks = tasks.filter((task) => task.id !== id);
    if (!currentUser) saveLocalTasks();
    renderTasks();
    showToast(currentUser ? "Task removed from your account." : "Task removed from this device.");
  } catch (error) {
    showToast(error.message);
  }
}

async function requestTaskPayment(task) {
  if (!currentUser) {
    showToast("Sign in and link a verified parent or guardian before requesting payment approval.");
    byId("account-dialog").showModal();
    return;
  }
  try {
    const response = await fetch("/api/payment-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: task.id,
        description: task.title,
        amountPaise: task.amountPaise,
        method: task.paymentMethod || "upi",
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create payment request.");
    task.paymentStatus = "awaiting_guardian";
    showToast(data.message);
    renderTasks();
    await refreshPaymentRequests();
  } catch (error) {
    showToast(error.message);
  }
}

function initializeVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = byId("voice-button");
  if (!Recognition) return;
  voiceInputAvailable = true;
  button.disabled = !configuration?.groq?.ready;
  button.title = "Record a short message using browser speech recognition";
  button.addEventListener("click", () => {
    const recognition = new Recognition();
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = false;
    button.disabled = true;
    button.textContent = "…";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (!transcript) return;
      messageInput.value = transcript;
      messageSource = "voice";
      messageInput.focus();
      showToast("Voice transcript ready. Review it, then press Send. This uses browser speech recognition, not Gnani.");
    };
    recognition.onerror = (event) => showToast(`Voice input failed: ${event.error}.`);
    recognition.onend = () => {
      button.disabled = !configuration?.groq?.ready;
      button.textContent = "Mic";
    };
    recognition.start();
  });
}

async function transcribeVoiceFile(event) {
  event.preventDefault();
  const file = byId("voice-audio-file").files[0];
  if (!file || !configuration?.gnani?.ready) return;
  if (file.size > 6 * 1024 * 1024) {
    showToast("Choose an audio clip smaller than 6 MB.");
    return;
  }
  const submit = byId("voice-upload-submit");
  submit.disabled = true;
  submit.textContent = "Transcribing…";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const response = await fetch("/api/gnani/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: btoa(binary),
        fileName: file.name,
        mimeType: file.type,
        language: byId("voice-language").value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Gnani could not transcribe this audio.");
    if (window.lifeOpsContainsSensitiveContactData(data.transcript)) {
      throw new Error("This transcript contains private contact or payment-security information, so it was not added to chat.");
    }
    messageInput.value = data.transcript;
    messageSource = "voice";
    messageInput.focus();
    addEvent({
      title: "Gnani transcribed an uploaded voice clip",
      source: "Gnani Prisma STT · transcript awaits student review",
      details: `Audio format: ${file.name.split(".").pop().toLowerCase()}; provider request ID: ${data.requestId || "not returned"}. Audio was not saved by LifeOps.`,
    });
    showToast("Gnani transcript ready. Review or edit it, then press Send.");
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = !configuration?.gnani?.ready;
    submit.textContent = "Transcribe with Gnani";
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === "signup";
  byId("auth-name-field").hidden = !isSignup;
  byId("auth-submit").textContent = isSignup ? "Create account" : "Sign in";
  byId("auth-mode-toggle").textContent = isSignup ? "I already have an account" : "Create account instead";
  byId("auth-password").autocomplete = isSignup ? "new-password" : "current-password";
}

function updateAccountUi() {
  const configured = Boolean(configuration?.supabase?.ready);
  byId("email-provider-status").textContent = configuration?.email?.ready
    ? "Guardian emails are ready to send through Resend."
    : "Guardian emails are not configured yet. Add a Resend API key and verified sender in .env.";
  byId("account-footnote").textContent = configured
    ? "Supabase credentials are configured. Apply the full database/schema.sql for a fresh project or the numbered migration for an existing project. Email verification confirms control of an inbox, not legal guardianship. Never add real student or payment data to this prototype."
    : "Accounts and cloud data are disabled until Supabase is configured. Email verification confirms control of an inbox, not legal guardianship. Never add real student or payment data to this prototype.";
  byId("account-button").textContent = currentUser?.displayName || currentUser?.email || (configured ? "Sign in" : "Account");
  byId("account-status").textContent = currentUser
    ? `Signed in as ${currentUser.email} · ${currentUser.accountType}`
    : configured ? "Sign in or create a student or guardian account." : "Account sync unavailable · configure Supabase to enable sign-up.";
  byId("auth-form").hidden = Boolean(currentUser);
  byId("signed-in-tools").hidden = !currentUser;
  byId("guardian-invite-form").hidden = currentUser?.accountType !== "student";
  byId("guardian-accept-form").hidden = currentUser?.accountType !== "guardian";
  byId("limit-request-form").hidden = currentUser?.accountType !== "student";
  byId("limit-request-status").textContent = currentUser?.accountType === "student"
    ? "Your current limit will not change until a verified guardian account matching the submitted email approves."
    : "Sign in with a student account to request a change.";
  if (currentUser) byId("signed-in-label").textContent = `${currentUser.displayName || currentUser.email} · ${currentUser.accountType}`;
  if (!currentUser && configuration?.supabase?.ready) {
    byId("account-status").textContent = "Sign in or create a student or guardian account. Use a verified parent/guardian account for payment approvals.";
  }
}

async function persistConversationMessage(role, content, source) {
  if (!currentUser) return;
  const response = await fetch("/api/conversation-messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, role, content, source }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not sync conversation history.");
}

async function loadTasks() {
  if (!currentUser) {
    tasks = localTasks();
    renderTasks();
    return;
  }
  const response = await fetch("/api/tasks", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load your tasks.");
  tasks = data.tasks.map(normalizeTask);
  renderTasks();
}

async function loadConversation() {
  if (!currentUser) return;
  const response = await fetch(`/api/conversation-messages?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load saved chat.");
  if (!data.messages.length) return;
  chatContent.replaceChildren();
  for (const message of data.messages) {
    const role = message.role === "assistant" ? "agent" : "user";
    addBubble(role, message.content, role === "agent" ? "LifeOps · saved reply" : message.source === "voice" ? "You · voice message" : "You");
    appendLiveMessage({ role: message.role, content: message.content });
  }
  runMode = "live";
  byId("chat-mode").textContent = "Saved account conversation";
}

async function loadActivityHistory() {
  renderSettingsActivity();
  const history = byId("chat-history-list");
  history.replaceChildren();
  if (!currentUser) {
    history.textContent = "Sign in to view saved conversations.";
    return;
  }
  const response = await fetch("/api/conversations", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load conversation history.");
  const conversations = new Map();
  for (const message of data.messages) {
    if (!conversations.has(message.conversation_id)) conversations.set(message.conversation_id, []);
    conversations.get(message.conversation_id).push(message);
  }
  if (!conversations.size) {
    history.textContent = "No saved conversations yet.";
    return;
  }
  for (const [id, messages] of conversations) {
    const item = document.createElement("div");
    item.className = "history-item";
    const open = document.createElement("button");
    const firstUserMessage = messages.find((message) => message.role === "user")?.content || "Conversation";
    open.textContent = firstUserMessage.slice(0, 90);
    open.addEventListener("click", () => openSavedConversation(id).catch((error) => showToast(error.message)));
    const meta = document.createElement("small");
    meta.textContent = `${messages.length} messages · ${new Date(messages[0].created_at).toLocaleString("en-IN")}`;
    open.append(meta);
    item.append(open);
    history.append(item);
  }
}

async function openSavedConversation(id) {
  conversationId = id;
  localStorage.setItem("lifeops-conversation-id", id);
  liveMessages.length = 0;
  chatContent.replaceChildren();
  const response = await fetch(`/api/conversation-messages?conversationId=${encodeURIComponent(id)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not open saved conversation.");
  for (const message of data.messages) {
    const role = message.role === "assistant" ? "agent" : "user";
    addBubble(role, message.content, role === "agent" ? "LifeOps · saved reply" : "You");
    appendLiveMessage({ role: message.role, content: message.content });
  }
  runMode = "live";
  byId("chat-mode").textContent = "Saved account conversation";
  showWorkspaceView("chat");
}

async function refreshPaymentRequests() {
  if (!currentUser) return;
  const response = await fetch("/api/payment-requests", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load payment requests.");
  const list = byId("payment-request-list");
  list.replaceChildren();
  if (!data.requests.length) {
    list.textContent = "No payment requests.";
    return;
  }
  for (const request of data.requests) {
    const item = document.createElement("article");
    item.className = "payment-request";
    const description = document.createElement("strong");
    description.textContent = request.description;
    const amount = document.createElement("span");
    amount.textContent = `₹${(request.amount_paise / 100).toFixed(2)} · ${request.method.toUpperCase()} · ${request.status.replaceAll("_", " ")}`;
    item.append(description, amount);
    const pineStatus = pineStatusByRequestId.get(request.id);
    if (pineStatus) {
      const providerStatus = document.createElement("small");
      providerStatus.className = "payment-request-status";
      providerStatus.textContent = `Last Pine Labs status on this device: ${pineStatus}`;
      item.append(providerStatus);
    }
    if (currentUser.accountType === "guardian" && request.status === "awaiting_guardian") {
      const actions = document.createElement("div");
      actions.className = "payment-request-actions";
      for (const status of ["approved", "declined"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = status === "approved" ? "Approve request" : "Decline";
        button.addEventListener("click", () => updatePaymentRequest(request.id, status));
        actions.append(button);
      }
      item.append(actions);
    }
    if (currentUser.accountType === "student" && request.approved_by && ["approved", "checkout_pending"].includes(request.status)) {
      const actions = document.createElement("div");
      actions.className = "payment-request-actions";
      const checkout = document.createElement("button");
      checkout.type = "button";
      checkout.textContent = "Continue to Pine Labs checkout";
      checkout.disabled = !configuration?.pineLabs?.ready;
      checkout.title = checkout.disabled ? "Configure Pine Labs credentials and callback URL in .env" : "Guardian approval is required; the payer still confirms payment in hosted checkout.";
      checkout.addEventListener("click", () => startPineLabsCheckout(request.id));
      actions.append(checkout);
      if (pineStatusByRequestId.has(request.id)) {
        const refreshStatus = document.createElement("button");
        refreshStatus.type = "button";
        refreshStatus.textContent = "Re-check Pine Labs status";
        refreshStatus.disabled = !configuration?.pineLabs?.ready;
        refreshStatus.addEventListener("click", () => checkPineLabsStatus(request.id));
        actions.append(refreshStatus);
      }
      item.append(actions);
    }
    list.append(item);
    const task = tasks.find((candidate) => candidate.id === request.task_id);
    if (task) task.paymentStatus = request.status;
  }
  renderTasks();
}

async function startPineLabsCheckout(id) {
  try {
    const response = await fetch(`/api/payment-requests/${encodeURIComponent(id)}/checkout`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start Pine Labs checkout.");
    showToast(data.message);
    window.location.assign(data.redirectUrl);
  } catch (error) {
    showToast(error.message);
  }
}

async function checkPineLabsStatus(id) {
  try {
    const response = await fetch(`/api/payment-requests/${encodeURIComponent(id)}/pine-status`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not verify the Pine Labs status.");
    pineStatusByRequestId.set(id, data.status);
    localStorage.setItem("lifeops-pine-statuses", JSON.stringify([...pineStatusByRequestId].slice(-100)));
    await refreshPaymentRequests();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshLimitRequests() {
  const list = byId("limit-approval-list");
  list.replaceChildren();
  if (!currentUser) {
    list.textContent = "Sign in to view guardian approval requests.";
    return;
  }
  const response = await fetch("/api/limit-change-requests", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load payment-limit approvals.");
  if (!data.requests.length) {
    list.textContent = "No payment-limit requests.";
    return;
  }
  for (const request of data.requests) {
    const item = document.createElement("article");
    item.className = "payment-request";
    const detail = document.createElement("strong");
    detail.textContent = `₹${(request.current_limit_paise / 100).toFixed(2)} → ₹${(request.requested_limit_paise / 100).toFixed(2)}`;
    const status = document.createElement("span");
    status.className = "payment-request-status";
    status.textContent = request.status.replaceAll("_", " ");
    item.append(detail, status);
    const timestamp = document.createElement("small");
    timestamp.textContent = `${request.guardian_email} · ${new Date(request.created_at).toLocaleString("en-IN")}`;
    item.append(timestamp);
    if (currentUser.accountType === "student" && request.status === "pending") {
      const resend = document.createElement("button");
      resend.type = "button";
      resend.className = "text-button";
      resend.textContent = "Resend approval email";
      resend.addEventListener("click", () => resendLimitRequest(request.id));
      item.append(resend);
    }
    if (currentUser.accountType === "guardian" && request.status === "pending") {
      const actions = document.createElement("div");
      actions.className = "payment-request-actions";
      for (const decision of ["approved", "declined"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = decision === "approved" ? "Approve new limit" : "Decline";
        button.addEventListener("click", () => decideLimitRequest(request.id, decision));
        actions.append(button);
      }
      item.append(actions);
    }
    list.append(item);
  }
}

async function refreshApprovalData() {
  if (!currentUser) return;
  await Promise.all([refreshPaymentRequests(), refreshLimitRequests(), loadSettings()]);
}

async function requestLimitChange(event) {
  event.preventDefault();
  if (!currentUser || currentUser.accountType !== "student") {
    showToast("Sign in with a student account to request a payment-limit change.");
    return;
  }
  const requestedLimitPaise = Math.round(Number(byId("requested-approval-limit").value) * 100);
  const guardianEmail = byId("limit-guardian-email").value.trim();
  const submit = event.submitter || byId("limit-request-form").querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch("/api/limit-change-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guardianEmail, requestedLimitPaise }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not request guardian approval.");
    byId("limit-request-status").textContent = data.message;
    byId("limit-request-form").reset();
    saveSettingsActivity(`Requested guardian approval to change the payment limit to ₹${(requestedLimitPaise / 100).toFixed(2)}.`);
    await refreshLimitRequests();
    showToast(data.message);
  } catch (error) {
    byId("limit-request-status").textContent = error.message;
    showToast(error.message);
    await refreshLimitRequests().catch((refreshError) => showToast(refreshError.message));
  } finally {
    submit.disabled = false;
  }
}

async function resendLimitRequest(id) {
  try {
    const response = await fetch(`/api/limit-change-requests/${encodeURIComponent(id)}/resend`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not resend the approval email.");
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function decideLimitRequest(id, decision) {
  try {
    const response = await fetch(`/api/limit-change-requests/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not record guardian decision.");
    saveSettingsActivity(`Guardian ${decision} a payment-limit change request.`);
    await refreshApprovalData();
    await loadActivityHistory();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function updatePaymentRequest(id, status) {
  try {
    const response = await fetch(`/api/payment-requests/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not update payment request.");
    showToast(data.message);
    await refreshPaymentRequests();
  } catch (error) {
    showToast(error.message);
  }
}

async function initializeAccount() {
  if (!configuration?.supabase?.ready) {
    updateAccountUi();
    return;
  }
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.user) {
      updateAccountUi();
      return;
    }
    currentUser = data.user;
    updateAccountUi();
    await loadTasks();
    await loadConversation();
    await loadSettings();
    await cleanupExpiredHistory();
    await refreshApprovalData();
    await loadActivityHistory();
  } catch (error) {
    if (/guardian_limit_requests|respond_to_guardian_limit_request|save_user_preferences/i.test(error.message)) {
      const message = "Run LifeOps/database/migrations/002_guardian_limit_approvals.sql in a new Supabase SQL Editor query, then sign in again.";
      byId("account-status").textContent = message;
      showToast(message);
      return;
    }
    if (/permission denied for table ([a-z_]+)/i.test(error.message)) {
      const table = error.message.match(/permission denied for table ([a-z_]+)/i)?.[1] || "required data";
      const message = `Supabase is missing access grants for ${table}. Run the “LifeOps Supabase permissions” SQL block in the project README, then sign out and sign in again.`;
      byId("account-status").textContent = message;
      showToast(message);
      return;
    }
    if (/Could not find the table 'public\.(?:tasks|conversation_messages|user_settings|payment_requests)' in the schema cache/i.test(error.message)) {
      const table = error.message.match(/public\.[a-z_]+/i)?.[0] || "a required table";
      const message = `Supabase sign-in succeeded, but ${table} is missing. In your Supabase SQL Editor, run database/schema.sql from the LifeOps project, then reload and sign in again.`;
      byId("account-status").textContent = message;
      showToast(message);
      return;
    }
    showToast(error.message);
  }
}

async function onAccountSubmit(event) {
  event.preventDefault();
  const payload = {
    email: byId("auth-email").value,
    password: byId("auth-password").value,
  };
  let path = "/api/auth/login";
  if (authMode === "signup") {
    path = "/api/auth/signup";
    payload.displayName = byId("auth-name").value;
    payload.accountType = byId("auth-account-type").value;
  }
  const submit = byId("auth-submit");
  submit.disabled = true;
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Account request failed.");
    byId("account-status").textContent = data.message || `Signed in as ${data.user.email}.`;
    if (data.user) {
      currentUser = data.user;
      updateAccountUi();
      await loadTasks();
      await loadConversation();
      await loadSettings();
      await cleanupExpiredHistory();
      await refreshApprovalData();
      await loadActivityHistory();
    }
  } catch (error) {
    const message = /guardian_limit_requests|respond_to_guardian_limit_request|save_user_preferences/i.test(error.message)
      ? "Run LifeOps/database/migrations/002_guardian_limit_approvals.sql in a new Supabase SQL Editor query, then sign in again."
      : error.message;
    byId("account-status").textContent = message;
  } finally {
    submit.disabled = false;
  }
}

async function loadSettings() {
  let settings = { chat_retention_days: 90, theme: "system" };
  try {
    settings = { ...settings, ...JSON.parse(localStorage.getItem(localSettingsKey) || "{}") };
  } catch {}
  if (currentUser) {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load settings.");
    settings = data.settings;
  }
  const theme = settings.theme || "system";
  byId("settings-theme").value = theme;
  const paymentLimit = currentUser ? settings.payment_approval_limit_paise : null;
  byId("current-approval-limit").textContent = paymentLimit === null || paymentLimit === undefined
    ? "Sign in to view"
    : `₹${(paymentLimit / 100).toFixed(2)}`;
  byId("chat-retention-days").value = settings.chat_retention_days ?? 90;
  if (theme === "system") {
    localStorage.removeItem("lifeops-theme");
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } else {
    localStorage.setItem("lifeops-theme", theme);
    applyTheme(theme);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const retention = Number(byId("chat-retention-days").value);
  const theme = byId("settings-theme").value;
  if (!Number.isInteger(retention) || retention < 7 || retention > 365) {
    showToast("Chat retention must be from 7 to 365 days.");
    return;
  }
  const settings = { theme, chat_retention_days: retention };
  localStorage.setItem(localSettingsKey, JSON.stringify(settings));
  if (currentUser) {
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme, chatRetentionDays: retention }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save account settings.");
    } catch (error) {
      showToast(error.message);
      return;
    }
  }
  if (theme === "system") {
    localStorage.removeItem("lifeops-theme");
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } else {
    localStorage.setItem("lifeops-theme", theme);
    applyTheme(theme);
  }
  saveSettingsActivity(`Appearance set to ${theme}; chat retention set to ${retention} days.`);
  showToast("Settings saved. A guardian must approve any payment-limit change.");
}

async function cleanupExpiredHistory() {
  if (!currentUser) return;
  const response = await fetch("/api/retention/cleanup", { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not apply the chat retention setting.");
}

async function createTaskFromForm(event) {
  event.preventDefault();
  const title = byId("task-title-input").value.trim();
  const due = byId("task-due-input").value;
  const notes = byId("task-notes-input").value.trim();
  const requiresPayment = byId("task-payment-required").checked;
  const amountRupees = Number(byId("task-payment-amount").value);
  if (!title) return;
  if (requiresPayment && (!Number.isFinite(amountRupees) || amountRupees <= 0 || amountRupees > 50000)) {
    showToast("Enter a payment amount between ₹0.01 and ₹50,000.");
    return;
  }
  try {
    await appendTask({
      title,
      notes,
      dueAt: due ? `${due}T23:59:00+05:30` : null,
      status: "open",
      createdVia: "manual",
      conversationId,
      requiresPayment,
      amountPaise: requiresPayment ? Math.round(amountRupees * 100) : null,
      paymentMethod: requiresPayment ? byId("task-payment-method").value : null,
    });
    messageSource = "chat";
    byId("task-form").reset();
    byId("payment-fields").hidden = true;
    showToast(currentUser ? "Task saved to your account." : "Task saved on this device.");
  } catch (error) {
    showToast(error.message);
  }
}

async function inviteGuardian(event) {
  event.preventDefault();
  if (!currentUser || currentUser.accountType !== "student") return;
  try {
    const response = await fetch("/api/guardian-invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: byId("guardian-email").value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create guardian invitation.");
    byId("guardian-invite-result").textContent = `${data.message} Expires ${new Date(data.invitation.expires_at).toLocaleString()}.`;
  } catch (error) {
    showToast(error.message);
  }
}

async function acceptGuardianInvite(event) {
  event.preventDefault();
  if (!currentUser || currentUser.accountType !== "guardian") return;
  try {
    const response = await fetch("/api/guardian-invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: byId("guardian-code").value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not verify guardian invitation.");
    showToast(data.message);
    byId("guardian-code").value = "";
    await refreshPaymentRequests();
  } catch (error) {
    showToast(error.message);
  }
}

function localTime(timestamp) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function addEvent({ time = indiaTimestamp(), title, source, details, payload }) {
  runEvidence.push({ time, title, source, ...(details ? { details } : {}), ...(payload !== undefined ? { payload } : {}) });
  byId("export-button").disabled = false;
  const empty = eventLog.querySelector(".event-empty");
  if (empty) empty.remove();
  const item = document.createElement("li");
  item.className = "event-item";

  const timeLabel = document.createElement("span");
  timeLabel.className = "event-time";
  timeLabel.textContent = localTime(time);
  item.append(timeLabel);

  const body = document.createElement("div");
  body.className = "event-body";
  body.append(document.createTextNode(title));
  const meta = document.createElement("span");
  meta.className = "event-meta";
  meta.textContent = source;
  body.append(meta);
  if (details) {
    const text = document.createElement("div");
    text.className = "event-details";
    text.textContent = details;
    body.append(text);
  }
  item.append(body);

  if (payload !== undefined) {
    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Inspect exact request / response";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(payload, null, 2);
    disclosure.append(summary, pre);
    item.append(disclosure);
  }
  eventLog.append(item);
  eventLog.scrollTop = eventLog.scrollHeight;
  byId("trace-status").textContent = "RUN EVIDENCE";
  byId("trace-status").classList.add("live");
}

function addBubble(role, message, caption) {
  const empty = byId("empty-chat");
  if (empty) empty.remove();
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  const label = document.createElement("span");
  label.className = "bubble-caption";
  label.textContent = caption;
  const text = document.createElement("span");
  text.textContent = message;
  bubble.append(label, text);
  chatContent.append(bubble);
  chatContent.scrollTop = chatContent.scrollHeight;
  return bubble;
}

function showApproval(task, parent, source = "chat") {
  const approval = document.createElement("div");
  approval.className = "task-approval";
  const title = document.createElement("strong");
  title.textContent = `Proposed: ${task.title}`;
  const due = document.createElement("span");
  due.textContent = task.dueDate ? `Deadline given: ${task.dueDate}` : "No deadline set";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Add to tasks";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const saved = await persistTask({
        title: task.title,
        dueAt: /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate || "") ? `${task.dueDate}T23:59:00+05:30` : null,
        notes: task.requiresPayment ? `Payment task · amount: ${task.amountPaise ? `₹${(task.amountPaise / 100).toFixed(2)}` : "not set"} · ${task.paymentMethod || "method not set"}` : "",
        status: "open",
        createdVia: messageSource,
        conversationId,
        requiresPayment: Boolean(task.requiresPayment && Number.isInteger(task.amountPaise) && task.amountPaise > 0),
        amountPaise: Number.isInteger(task.amountPaise) && task.amountPaise > 0 ? task.amountPaise : null,
        paymentMethod: ["upi", "card"].includes(task.paymentMethod) ? task.paymentMethod : null,
      });
      const approvedAt = indiaTimestamp();
      addEvent({
        time: approvedAt,
        title: `Student approved task: "${task.title}"`,
        source: "Student tapped the in-page approval button",
        details: currentUser ? "Saved to the signed-in Supabase account." : "Saved only in local browser storage. No reminder or external action was created.",
      });
      button.textContent = "Added to tasks";
      due.textContent = currentUser ? "Saved to your account" : "Saved on this device only";
      showWorkspaceView("tasks");
      return saved;
    } catch (error) {
      button.disabled = false;
      showToast(error.message);
    }
  }, { once: true });
  approval.append(title, due, button);
  parent.append(approval);
}

function showTaskUpdateApproval(update, parent) {
  const existing = tasks.find((task) => task.id === update.taskId);
  if (!existing) return;
  const approval = document.createElement("div");
  approval.className = "task-approval";
  const title = document.createElement("strong");
  title.textContent = `Suggested change: ${existing.title}`;
  const summary = document.createElement("span");
  summary.textContent = `${update.title || existing.title} · ${update.dueDate || "no due date"} · ${update.status}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Approve task update";
  button.addEventListener("click", async () => {
    button.disabled = true;
    const changes = { status: update.status };
    if (update.title) changes.title = update.title;
    if (update.dueDate !== undefined) changes.dueAt = update.dueDate ? `${update.dueDate}T23:59:00+05:30` : null;
    const saved = await updateTask(existing.id, changes);
    button.textContent = saved ? "Task updated" : "Update failed";
    summary.textContent = saved ? "Student approved and saved this change." : "The change was not saved.";
  }, { once: true });
  approval.append(title, summary, button);
  parent.append(approval);
}

function renderAgentResult(result, mode, source = "chat") {
  lastReply = result.reply;
  byId("speak-button").disabled = !configuration?.gnani?.ready && !("speechSynthesis" in window);
  addBubble("agent", result.reply, mode === "live" ? "LifeOps" : "Scripted example · not AI");
  byId("chat-actions").hidden = false;
  for (const task of result.proposedTasks || []) {
    if (task && typeof task.title === "string" && task.title.trim()) showApproval(task, chatContent, source);
  }
  for (const update of result.proposedTaskUpdates || []) {
    if (update && typeof update.taskId === "string") showTaskUpdateApproval(update, chatContent);
  }
  chatContent.scrollTop = chatContent.scrollHeight;
}

async function appendTask(task) {
  const saved = await persistTask(task);
  renderTasks();
  return saved;
}

function recordConnectorTraces(traces) {
  for (const trace of traces || []) {
    addEvent({
      time: trace.calledAt || indiaTimestamp(),
      title: `${trace.connector} ${trace.method} · HTTP ${trace.status}`,
      source: `Agent connector call · ${trace.endpoint}`,
      details: "Authorization credentials are deliberately omitted from this view; request body and actual response are shown.",
      payload: {
        endpoint: trace.endpoint,
        method: trace.method,
        requestHeaders: trace.requestHeaders,
        request: trace.request,
        responseStatus: trace.status,
        responseReceivedAt: trace.receivedAt,
        response: trace.response,
      },
    });
  }
}

function recordDecisions(data, input) {
  for (const [index, decision] of data.result.decisions.entries()) {
    const proposals = data.result.proposedTasks.map((task) =>
      `"${task.title}"${task.dueDate ? ` (deadline: ${task.dueDate})` : ""}`
    );
    const proposalAction = proposals.length
      ? ` Proposed checklist items shown in the app for student approval: ${proposals.join(", ")}.`
      : "";
    addEvent({
      time: data.decidedAt,
      title: `Decision ${index + 1}: ${decision.decision}`,
      source: `Exact trigger: "${input}" · ${data.source} · model: ${configuration.groq.model}`,
      details: `Rule followed: ${decision.rule}. Visible reply to the student: "${data.result.reply}".${proposalAction}`,
    });
  }
}

function setLiveControls() {
  const liveReady = Boolean(configuration?.groq?.ready);
  messageInput.disabled = !liveReady;
  sendButton.disabled = !liveReady;
  byId("voice-button").disabled = !liveReady || !voiceInputAvailable;
  byId("voice-upload-submit").disabled = !configuration?.gnani?.ready;
  byId("voice-provider-note").textContent = configuration?.gnani?.ready
    ? `Gnani API key configured · ${configuration.gnani.language}. Audio clips are sent to Gnani for transcription; review the transcript before sending it to chat.`
    : "Gnani is not configured. Add GNANI_API_KEY to .env; the API key stays on the local server.";
  messageInput.placeholder = liveReady ? "Write a message…" : "Live chat is not set up on this computer";
  const banner = byId("mode-banner");
  const copy = byId("mode-copy");
  const footnote = byId("chat-footnote");
  if (liveReady) {
    banner.classList.add("live");
    copy.textContent = `Live chat · ${configuration.groq.model}`;
    byId("chat-mode").textContent = "Schoolwork companion";
    footnote.textContent = "For each live request, LifeOps sends your latest 32 chat messages (up to 16 exchanges) and active task titles/deadlines to Groq as context. Older messages stay visible but are not sent. Groq generates the reply and may not follow every detail. If signed in, chat and tasks are also stored in Supabase. New chat does not delete saved history. Use fictional schoolwork in this prototype.";
  } else {
    copy.textContent = "Example mode · scripted reply, not live AI";
    byId("chat-mode").textContent = "Schoolwork companion";
    footnote.textContent = "This computer is set up for the scripted example, not live chat. Use fictional schoolwork in this prototype. To configure live chat, see the setup instructions in the README.";
  }
}

async function loadConfiguration() {
  let response;
  try {
    response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`Status endpoint returned HTTP ${response.status}.`);
    configuration = await response.json();
  } catch (error) {
    byId("mode-copy").textContent = "Reconnecting to LifeOps…";
    byId("chat-footnote").textContent = `LifeOps could not reach its local server (${error.message}). It will retry automatically.`;
    messageInput.disabled = true;
    rehearsalButton.disabled = true;
    sendButton.disabled = true;
    byId("voice-button").disabled = true;
    byId("voice-upload-submit").disabled = true;
    tasks = localTasks();
    renderTasks();
    updateAccountUi();
    setTimeout(() => loadConfiguration().catch((retryError) => showToast(retryError.message)), 3000);
    return;
  }
  setLiveControls();
  renderTasks();
  updateAccountUi();
  try {
    await initializeAccount();
    await handlePineLabsReturn();
  } catch (error) {
    showToast(`LifeOps loaded, but account setup failed: ${error.message}`);
  }
}

async function loadPrompt() {
  try {
    const response = await fetch("/api/prompt", { cache: "no-store" });
    if (!response.ok) throw new Error(`Prompt endpoint returned HTTP ${response.status}.`);
    const data = await response.json();
    byId("system-prompt").textContent = data.prompt;
  } catch (error) {
    byId("system-prompt").textContent = `Could not load the system prompt: ${error.message}`;
  }
}

async function loadEvaluationPack() {
  const cases = byId("evaluation-cases");
  const runs = byId("evaluation-run-log");
  try {
    const response = await fetch("/evaluation-pack.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Evaluation pack returned HTTP ${response.status}.`);
    const pack = await response.json();
    cases.replaceChildren();
    for (const item of pack.evaluationCases) {
      const row = document.createElement("li");
      const scenario = document.createElement("strong");
      scenario.textContent = `${item.id.toUpperCase()} · ${item.scenario} `;
      const expected = document.createElement("span");
      expected.textContent = `Expected: ${item.expectedBehavior} [${item.status}]`;
      row.append(scenario, expected);
      cases.append(row);
    }
    runs.replaceChildren();
    for (const run of pack.runLog) {
      const row = document.createElement("li");
      row.className = "event-item";
      const time = document.createElement("span");
      time.className = "event-time";
      time.textContent = new Date(run.observedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const body = document.createElement("div");
      body.className = "event-body";
      const title = document.createElement("strong");
      title.textContent = `${run.system} · ${run.result}`;
      const meta = document.createElement("span");
      meta.className = "event-meta";
      meta.textContent = `${run.requestedSamples} requested · ${run.reportedGeneratedSamples} generated · ${run.toolInvocationEvidence}`;
      const details = document.createElement("div");
      details.className = "event-details";
      details.textContent = `${run.evidence} ${run.limitations} ${run.errorDetail}`;
      body.append(title, meta, details);
      row.append(time, body);
      runs.append(row);
    }
  } catch (error) {
    cases.textContent = `Could not load evaluation cases: ${error.message}`;
    runs.textContent = `Could not load observed run history: ${error.message}`;
  }
}

byId("download-evaluation-pack").addEventListener("click", async () => {
  try {
    const [packResponse, promptResponse] = await Promise.all([
      fetch("/evaluation-pack.json", { cache: "no-store" }),
      fetch("/api/prompt", { cache: "no-store" }),
    ]);
    if (!packResponse.ok || !promptResponse.ok) throw new Error("Could not retrieve the complete evidence pack and current prompt.");
    const [pack, promptData] = await Promise.all([packResponse.json(), promptResponse.json()]);
    pack.promptVersionRecord.currentLocalPrompt.prompt = promptData.prompt;
    pack.promptVersionRecord.currentLocalPrompt.capturedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "lifeops-round-3-evaluation-pack.json";
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    showToast(`Evidence export failed: ${error.message}`);
  }
});

function addRehearsalInput() {
  runMode = "scripted rehearsal";
  const input = "I've got a maths worksheet with 8 questions due tomorrow and science notes due Friday. Football is at 6 — help me plan.";
  const receivedAt = indiaTimestamp();
  const reply = "I heard two school tasks: the maths worksheet for tomorrow and science notes for Friday. I won't guess how much time you need around football. Would you like me to add these two tasks to this demo checklist?";
  addBubble("user", input, "Sample student message · scripted scenario");
  addEvent({
    time: receivedAt,
    title: "Sample message received",
    source: "LifeOps built-in example · not a real student or external source",
    details: input,
  });
  addEvent({
    time: receivedAt,
    title: "Decision 1: preserve only the two school tasks the student stated",
    source: "Rehearsal only · no AI model call",
    details: `Input: "${input}" Source: built-in sample scenario, not a real student. Rule R1: use only work/constraints supplied by the student; never invent assignments, dates, school rules, people, calendar entries, or completed actions. Action: propose only the maths worksheet and science notes.`,
  });
  addEvent({
    time: receivedAt,
    title: "Decision 2: ask the student before adding either task",
    source: "Rehearsal only · scripted system-prompt rule",
    details: `Rule R3: the student must approve every proposed checklist item; do not claim actions were completed. Action to student, in the in-page chat: "${reply}"`,
  });
  addEvent({
    time: receivedAt,
    title: `LifeOps replied to the student: "${reply}"`,
    source: "In-page chat · scripted response, no external message",
  });
  renderAgentResult({
    reply,
    decisions: ["Keep only the two tasks the student stated; ask permission before changing the checklist."],
    proposedTasks: [
      { title: "Maths worksheet · 8 questions", dueDate: "tomorrow (as stated; rehearsal)" },
      { title: "Science notes", dueDate: "Friday (as stated; rehearsal)" },
    ],
  }, "rehearsal");
  byId("trace-status").textContent = "SCRIPTED REHEARSAL";
  byId("trace-status").classList.remove("live");
}

function clearRun() {
  runMode = "not-started";
  conversationId = crypto.randomUUID();
  localStorage.setItem("lifeops-conversation-id", conversationId);
  runEvidence.length = 0;
  byId("export-button").disabled = true;
  chatContent.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-chat";
  empty.id = "empty-chat";
  byId("chat-actions").hidden = true;
  const title = document.createElement("h4");
  title.textContent = "What’s on your mind?";
  const text = document.createElement("p");
  text.textContent = "Homework, a busy week, or just not knowing where to start — tell me a little about it.";
  empty.append(title, text, rehearsalButton);
  chatContent.append(empty);
  eventLog.replaceChildren();
  const eventEmpty = document.createElement("li");
  eventEmpty.className = "event-empty";
  eventEmpty.textContent = "Start a rehearsal or a configured live run to populate this trace.";
  eventLog.append(eventEmpty);
  byId("trace-status").textContent = "WAITING FOR A RUN";
  byId("trace-status").classList.remove("live");
  liveMessages.length = 0;
  lastReply = "";
  speakButton.disabled = true;
  const player = byId("gnani-audio-player");
  player.pause();
  player.removeAttribute("src");
  player.hidden = true;
  if (gnaniAudioUrl) URL.revokeObjectURL(gnaniAudioUrl);
  gnaniAudioUrl = undefined;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

async function sendLiveMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || requestInProgress || !configuration?.groq?.ready) return;
  if (window.lifeOpsContainsSensitiveContactData(text)) {
    showToast("For privacy, remove email addresses, phone numbers, passwords, one-time codes and payment security codes before sending. This message was not saved or sent.");
    return;
  }
  if (runMode !== "live") clearRun();
  requestInProgress = true;
  runMode = "live";
  sendButton.disabled = true;
  messageInput.disabled = true;
  const receivedAt = indiaTimestamp();
  const source = messageSource;
  messageSource = "chat";
  addBubble("user", text, `${source === "voice" ? "You · voice" : "You"} · ${localTime(receivedAt)}`);
  addEvent({
    time: receivedAt,
    title: "Student message received",
    source: source === "voice" ? "Student voice input · browser speech transcript reviewed in the chat" : "Student typed in the LifeOps prototype · source is the visible chat input",
    details: text,
  });
  appendLiveMessage({ role: "user", content: text });
  messageInput.value = "";
  byId("chat-mode").textContent = "Live run in progress…";
  try {
    await persistConversationMessage("user", text, source);
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: liveMessages,
        source,
        activeTasks: tasks.filter((task) => task.status === "open" || task.status === "in_progress").map(({ id, title, dueAt, status }) => ({ id, title, dueAt, status })),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      recordConnectorTraces(data.traces);
      throw new Error(data.error || `Agent returned HTTP ${response.status}.`);
    }
    const traces = data.traces || [];
    const groqIndex = traces.findIndex((trace) => trace.connector === "api.groq.com");
    if (groqIndex < 0) throw new Error("The live run returned no Groq connector receipt.");
    recordConnectorTraces(traces.slice(0, groqIndex + 1));
    appendLiveMessage({ role: "assistant", content: data.result.reply });
    try {
      await persistConversationMessage("assistant", data.result.reply, source);
    } catch (error) {
      showToast(`Reply was generated but could not be saved to your account: ${error.message}`);
    }
    recordDecisions(data, text);
    recordConnectorTraces(traces.slice(groqIndex + 1));
    addEvent({
      time: data.decidedAt,
      title: `LifeOps replied to the student: "${data.result.reply}"`,
      source: "In-page chat · no message sent to another person",
    });
    renderAgentResult(data.result, "live", source);
    byId("chat-mode").textContent = `Live model response · ${configuration.groq.model}`;
  } catch (error) {
    byId("chat-mode").textContent = "Live run stopped · see error";
    addEvent({
      title: "Run stopped with an error",
      source: "LifeOps local server",
      details: error.message,
    });
    showToast(error.message);
  } finally {
    requestInProgress = false;
    messageInput.disabled = !configuration?.groq?.ready;
    sendButton.disabled = !configuration?.groq?.ready;
    byId("voice-button").disabled = !configuration?.groq?.ready || !voiceInputAvailable;
    messageInput.focus();
  }
}

async function speakLastReply() {
  if (!lastReply) {
    showToast("There is no reply to read aloud.");
    return;
  }
  if (configuration?.gnani?.ready) {
    const button = byId("speak-button");
    button.disabled = true;
    try {
      const response = await fetch("/api/gnani/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: lastReply }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Gnani could not synthesize speech.");
      const audioBytes = Uint8Array.from(atob(data.audioBase64), (character) => character.charCodeAt(0));
      const player = byId("gnani-audio-player");
      if (gnaniAudioUrl) URL.revokeObjectURL(gnaniAudioUrl);
      gnaniAudioUrl = URL.createObjectURL(new Blob([audioBytes], { type: data.contentType || "audio/mpeg" }));
      player.src = gnaniAudioUrl;
      player.hidden = false;
      try {
        await player.play();
      } catch {
        showToast("Gnani audio is ready. Press Play in the audio controls.");
      }
      addEvent({
        title: "Gnani synthesized LifeOps's reply",
        source: "Gnani Timbre TTS · audio returned by the configured provider",
      });
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
    return;
  }
  if (!("speechSynthesis" in window)) {
    showToast("Spoken reply is not available in this browser.");
    return;
  }

  async function handlePineLabsReturn() {
    const params = new URLSearchParams(window.location.search);
    const paymentRequestId = params.get("paymentRequestId");
    if (!paymentRequestId) return;
    params.delete("paymentRequestId");
    params.delete("order_id");
    params.delete("status");
    params.delete("signature");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    if (!currentUser) {
      showToast("Sign in to verify the Pine Labs payment result with the provider.");
      return;
    }
    await checkPineLabsStatus(paymentRequestId);
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(lastReply);
  utterance.lang = "en-IN";
  utterance.onstart = () => {
    addEvent({
      title: `Browser TTS spoke LifeOps's reply: "${lastReply}"`,
      source: "Browser speechSynthesis · no Gnani endpoint is called; voice-service behavior depends on the browser",
    });
  };
  utterance.onerror = (event) => showToast(`Browser speech synthesis failed: ${event.error}.`);
  window.speechSynthesis.speak(utterance);
}

function updateStoryCount() {
  const words = byId("story-template").value.trim().split(/\s+/).filter(Boolean).length;
  byId("story-count").textContent = `${words} word${words === 1 ? "" : "s"}`;
  byId("story-count").classList.toggle("story-over-limit", words > 100);
}

function exportRun() {
  if (runEvidence.length === 0) return;
  const report = {
    product: "LifeOps",
    mode: runMode,
    model: runMode === "live" ? configuration?.groq?.model : null,
    exportedAt: indiaTimestamp(),
    notice: runMode === "scripted rehearsal"
      ? "Scripted rehearsal only. This is not a real student event, model response, or submission evidence."
      : "Live prototype trace only. Confirm participant consent and competition requirements; this export is not a complete submission.",
    storyDraft: byId("story-template").value,
    events: runEvidence,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lifeops-${runMode === "live" ? "live" : "rehearsal"}-trace.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

rehearsalButton.addEventListener("click", () => {
  if (requestInProgress) return;
  clearRun();
  addRehearsalInput();
  showToast("Example played · scripted, not AI-generated.");
});
byId("clear-button").addEventListener("click", () => {
  if (!requestInProgress) clearRun();
});
byId("chat-form").addEventListener("submit", sendLiveMessage);
speakButton.addEventListener("click", speakLastReply);
byId("voice-upload-form").addEventListener("submit", transcribeVoiceFile);
byId("export-button").addEventListener("click", exportRun);
byId("story-template").addEventListener("input", updateStoryCount);
byId("account-button").addEventListener("click", () => byId("account-dialog").showModal());
byId("hero-signup").addEventListener("click", () => {
  setAuthMode("signup");
  byId("account-dialog").showModal();
});
byId("settings-button").addEventListener("click", () => showWorkspaceView("settings"));
for (const tab of document.querySelectorAll(".workspace-tab")) {
  tab.addEventListener("click", () => showWorkspaceView(tab.dataset.view));
}
byId("auth-form").addEventListener("submit", onAccountSubmit);
byId("auth-mode-toggle").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));
byId("sign-out-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/auth/logout", { method: "POST" });
    if (!response.ok) throw new Error("Sign-out failed.");
    currentUser = null;
    tasks = localTasks();
    liveMessages.length = 0;
    byId("payment-request-list").textContent = "Sign in to view payment requests.";
    byId("limit-approval-list").textContent = "Sign in to view guardian approval requests.";
    byId("chat-history-list").textContent = "Sign in to view saved conversations.";
    byId("current-approval-limit").textContent = "Sign in to view";
    updateAccountUi();
    renderTasks();
    renderSettingsActivity();
    byId("account-dialog").close();
    showToast("Signed out. Local tasks remain on this device.");
  } catch (error) {
    showToast(error.message);
  }
});
byId("delete-conversation").addEventListener("click", async () => {
  if (!currentUser || !window.confirm("Permanently delete this conversation from your account? Tasks are not affected.")) return;
  try {
    const response = await fetch(`/api/conversation-messages?conversationId=${encodeURIComponent(conversationId)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not delete saved conversation.");
    clearRun();
    showToast("Saved conversation deleted. Tasks were kept.");
  } catch (error) {
    showToast(error.message);
  }
});
byId("task-form").addEventListener("submit", createTaskFromForm);
byId("task-payment-required").addEventListener("change", (event) => {
  byId("payment-fields").hidden = !event.target.checked;
});
byId("guardian-invite-form").addEventListener("submit", inviteGuardian);
byId("guardian-accept-form").addEventListener("submit", acceptGuardianInvite);
byId("settings-form").addEventListener("submit", saveSettings);
byId("limit-request-form").addEventListener("submit", requestLimitChange);
byId("refresh-payments").addEventListener("click", () => refreshApprovalData().catch((error) => showToast(error.message)));
byId("refresh-activity").addEventListener("click", () => loadActivityHistory().catch((error) => showToast(error.message)));
initializeVoiceInput();
updateStoryCount();
initializeTheme();
setAuthMode("login");
renderSettingsActivity();
tasks = localTasks();
renderTasks();
clearRun();
loadConfiguration();
loadPrompt();
loadEvaluationPack();
