import { backupAllPresets, DEFAULT_BACKUP, PRESET_COUNT, programChange, readVoice } from "./backup";
import { mountEditor, type Origin } from "./editor/editor";
import { inspectFirmware, type FirmwareInfo } from "./firmware/fwsc";
import { restoreStockFirmware, RestoreError, type RestoreStage } from "./firmware/restore";
import { BANKS, loadLibrary, saveLibrary, type BankId } from "./library";
import type { Connection } from "./midi/link";
import { openMidi, webMidiConnector } from "./midi/webmidi";
import { buildBankSysex, parseBankSysex, splitSysex, vcedName, vcedToVmem, vmemName } from "./protocol/dx7";
import { formatIdentity, isOtaLoader } from "./protocol/vendor";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const library = loadLibrary();
const LAST_BACKUP_KEY = "fm1-manager.lastBackup";
let access: MIDIAccess | null = null;
let device: Connection | null = null;
let firmware: FirmwareInfo | null = null;
let busy = false;
let capturedVoice: Uint8Array | null = null;
let backupAbort: AbortController | null = null;

// ------------------------------------------------------------------ helpers

function log(line: string) {
  const el = $("log");
  el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

function notify(text: string, kind: "" | "bad" = "") {
  const el = $("notice");
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.hidden = !text;
}

function download(name: string, data: Uint8Array) {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // storage blocked; fine for this session
    }
  },
};

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** One-line summary of a DX7 voice for the LCD: algorithm, feedback, transpose. */
const voiceSummary = (vced: Uint8Array) => {
  const t = vced[144] ?? 24;
  return `ALG ${(vced[134] ?? 0) + 1} · FB ${vced[135] ?? 0} · TRANSPOSE ${NOTES[t % 12]}${Math.floor(t / 12) + 1}`;
};

// -------------------------------------------------------------------- views

const VIEWS = ["presets", "editor", "firmware"] as const;

function showView() {
  const view = VIEWS.find((v) => location.hash === `#${v}`) ?? "presets";
  if (view !== "editor" && !$("view-editor").hidden) editor.hidden();
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll<HTMLAnchorElement>(".tabs a").forEach((a) => {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function refreshControls() {
  const ready = !!device && !busy && !isOtaLoader(device.identity);
  for (const id of ["read-voice", "backup-all"]) $<HTMLButtonElement>(id).disabled = !ready;
  $<HTMLButtonElement>("save-toggle").disabled = !capturedVoice || busy;
  $<HTMLButtonElement>("current-edit").disabled = !capturedVoice;
  editor.refresh();
  document.querySelectorAll<HTMLButtonElement>('[data-action="send"]').forEach((b) => (b.disabled = !ready));
  $<HTMLButtonElement>("fw-start").disabled = busy || !firmware?.stock || !$<HTMLInputElement>("fw-confirm").checked;
  $<HTMLButtonElement>("connect").disabled = busy;
}

// ------------------------------------------------------------------- device

function renderDevice(state: "off" | "on" | "ota" | "error", model: string, detail = "") {
  $("device-chip").dataset.state = state;
  $("device-model").textContent = model;
  $("device-detail").textContent = detail;
  $("connect").textContent = device ? "Reconnect" : "Connect";

  const installed = $("installed");
  const note = $("installed-note");
  if (device) {
    installed.textContent = formatIdentity(device.identity);
    note.textContent = isOtaLoader(device.identity)
      ? "The synth is in update mode. Run the restore to finish."
      : "Firmware reported by the synth.";
  } else {
    installed.textContent = "— — —";
    note.textContent = "Connect to see the installed firmware.";
  }
}

async function connect() {
  try {
    access ??= await openMidi();
    renderDevice("off", "Looking for the FM-1…");
    device?.link.close();
    device = await webMidiConnector(access)(() => true, 3000);
    if (!device) {
      renderDevice("error", "No FM-1 found", "Check the cable and close other MIDI apps");
    } else {
      const ota = isOtaLoader(device.identity);
      renderDevice(ota ? "ota" : "on", device.identity.model, ota ? "Update mode · USB" : `Firmware V${device.identity.version} · USB`);
      log(`connected: ${formatIdentity(device.identity)} on "${device.link.name}"`);
    }
  } catch (e) {
    renderDevice("error", "MIDI unavailable", (e as Error).message);
  }
  refreshControls();
}

// ------------------------------------------------------------ current sound

async function readCurrentVoice() {
  if (!device) return;
  const vced = await readVoice(device.link, 2000);
  if (!vced) {
    $("current-hint").textContent = "No answer";
    notify("The synth didn't answer. It may be running firmware that doesn't support reading sounds.", "bad");
    return;
  }
  capturedVoice = vced;
  $("current-name").textContent = vcedName(vced) || "(no name)";
  $("current-detail").textContent = voiceSummary(vced);
  $("current-hint").textContent = `Read ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  log(`read current sound: ${vcedName(vced)}`);
  refreshControls();
}

function toggleSaveForm() {
  const form = $("save-form");
  form.hidden = !form.hidden;
  $("save-toggle").setAttribute("aria-expanded", String(!form.hidden));
}

function saveCaptured(e: SubmitEvent) {
  e.preventDefault();
  if (!capturedVoice) return;
  const id = $<HTMLSelectElement>("save-bank").value as BankId;
  const index = Math.min(32, Math.max(1, Number($<HTMLInputElement>("save-slot").value) || 1)) - 1;
  library[id].voices[index] = vcedToVmem(capturedVoice);
  library[id].sentAt = null;
  saveLibrary(library);
  renderBanks();
  toggleSaveForm();
  notify(`Saved ${vcedName(capturedVoice)} to bank ${id}, slot ${index + 1}. Send bank ${id} to put it on the synth.`);
  log(`saved ${vcedName(capturedVoice)} to bank ${id} slot ${index + 1}`);
}

// ------------------------------------------------------------------- backup

function renderBackupSummary() {
  const when = storage.get(LAST_BACKUP_KEY);
  $("backup-when").textContent = when ? new Date(when).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never";
  $("backup-badge").hidden = !when;
  $("backup-fill").style.width = when ? "100%" : "0";
}

async function backupAll() {
  if (!device) return;
  busy = true;
  backupAbort = new AbortController();
  refreshControls();
  const status = $("backup-status");
  const fill = $("backup-fill");
  const channel = Number($<HTMLSelectElement>("backup-channel").value);
  fill.style.width = "0";
  $("backup-badge").hidden = true;
  $("backup-cancel").hidden = false;
  status.className = "small muted";
  try {
    const voices = await backupAllPresets(device.link, {
      ...DEFAULT_BACKUP,
      channel,
      signal: backupAbort.signal,
      progress: (done, name) => {
        fill.style.width = `${(100 * done) / PRESET_COUNT}%`;
        $("backup-bar").setAttribute("aria-valuenow", String(done));
        status.textContent = `Reading preset ${done} of ${PRESET_COUNT}: ${name}`;
      },
    });
    device.link.send(programChange(channel, 0));
    const now = new Date().toISOString();
    BANKS.forEach((id, b) => {
      library[id] = { source: "Backup from synth", voices: voices.slice(b * 32, b * 32 + 32).map(vcedToVmem), sentAt: now };
    });
    saveLibrary(library);
    storage.set(LAST_BACKUP_KEY, now);
    renderBanks();
    status.textContent = "All 128 presets are in the banks below. The synth is back on preset 1.";
    status.className = "small good";
    log("backed up all 128 presets");
  } catch (e) {
    status.textContent = `Stopped: ${(e as Error).message}`;
    status.className = "small bad";
    log(`backup stopped: ${(e as Error).message}`);
  } finally {
    busy = false;
    backupAbort = null;
    $("backup-cancel").hidden = true;
    renderBackupSummary();
    refreshControls();
  }
}

function downloadLibrary() {
  const banks = BANKS.map((id) => buildBankSysex(library[id].voices));
  const all = new Uint8Array(banks.reduce((n, b) => n + b.length, 0));
  banks.reduce((offset, b) => (all.set(b, offset), offset + b.length), 0);
  download(`fm1-backup-${new Date().toISOString().slice(0, 10)}.syx`, all);
}

// -------------------------------------------------------------------- banks

function renderBanks() {
  const template = $<HTMLTemplateElement>("bank-template");
  $("banks").replaceChildren(
    ...BANKS.map((id, b) => {
      const bank = library[id];
      const card = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const first = b * 32 + 1;
      card.querySelector(".bank-letter")!.textContent = id;
      card.querySelector("h3")!.textContent = `Bank ${id}`;
      const sub = card.querySelector<HTMLElement>(".bank-sub")!;
      sub.textContent = `Presets ${first}–${first + 31}`;
      sub.title = `Source: ${bank.source}`;
      const pill = card.querySelector(".pill")!;
      pill.textContent = bank.sentAt ? "On synth" : "Not sent";
      pill.setAttribute("title", bank.source);
      pill.classList.add(bank.sentAt ? "on" : "off");

      card.querySelector(".voices")!.replaceChildren(
        ...bank.voices.map((v, i) => {
          const li = document.createElement("li");
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "voice-btn";
          btn.title = "Open in the editor";
          const num = document.createElement("span");
          num.textContent = String(first + i).padStart(3, "0");
          const name = document.createElement("span");
          name.textContent = vmemName(v);
          const pen = document.createElement("span");
          pen.className = "voice-edit";
          pen.textContent = "Edit";
          btn.append(num, name, pen);
          btn.onclick = () => openInEditor(v, { bank: id, slot: i });
          li.append(btn);
          return li;
        }),
      );

      const send = card.querySelector<HTMLButtonElement>('[data-action="send"]')!;
      send.onclick = () => sendBank(id);
      send.setAttribute("aria-label", `Send bank ${id} to synth`);
      const importInput = card.querySelector<HTMLInputElement>('[data-action="import"] input')!;
      importInput.setAttribute("aria-label", `Import bank ${id} from a .syx file`);
      importInput.onchange = () => importFile(importInput.files?.[0], id);
      const exportBtn = card.querySelector<HTMLButtonElement>('[data-action="export"]')!;
      exportBtn.setAttribute("aria-label", `Export bank ${id} as .syx`);
      exportBtn.onclick = () => download(`fm1-bank-${id}.syx`, buildBankSysex(bank.voices));
      return card;
    }),
  );
  refreshControls();
}

/** Import a .syx file. A file holding four banks fills A to D; otherwise its first bank goes into `target`. */
async function importFile(file: File | undefined, target: BankId) {
  if (!file) return;
  try {
    const dumps = splitSysex(new Uint8Array(await file.arrayBuffer())).filter((m) => m.length === 4104);
    if (dumps.length === 0) throw new Error("there's no DX7 32-voice bank in this file");
    if (dumps.length === BANKS.length) {
      BANKS.forEach((b, i) => (library[b] = { source: file.name, voices: parseBankSysex(dumps[i]!), sentAt: null }));
      notify(`Imported ${file.name} into banks A to D.`);
    } else {
      library[target] = { source: file.name, voices: parseBankSysex(dumps[0]!), sentAt: null };
      notify(`Imported ${file.name} into bank ${target}.`);
    }
    saveLibrary(library);
    renderBanks();
    log(`imported ${file.name}`);
  } catch (e) {
    notify(`Couldn't import ${file.name}: ${(e as Error).message}.`, "bad");
  }
}

function sendBank(id: BankId) {
  if (!device) return;
  device.link.send(buildBankSysex(library[id].voices));
  library[id].sentAt = new Date().toISOString();
  saveLibrary(library);
  renderBanks();
  notify(`Sent bank ${id}. On the synth, choose bank ${id} when it asks where to store the presets.`);
  log(`sent bank ${id} (${library[id].source})`);
}

function openInEditor(vmem: Uint8Array, origin: Origin | null) {
  editor.open(vmem, origin);
  location.hash = "#editor";
  window.scrollTo(0, 0);
}

// ----------------------------------------------------------------- firmware

const STEP_OF: Record<RestoreStage, number> = { connecting: 1, checking: 1, rebooting: 2, writing: 3, confirming: 3, done: 4 };

function renderSteps(current: number) {
  document.querySelectorAll<HTMLElement>("#fw-steps li").forEach((li) => {
    const step = Number(li.dataset.step);
    li.dataset.state = current === 0 ? (step === 1 ? "next" : "") : step < current ? "done" : step === current ? "active" : "";
    const num = li.querySelector(".num")!;
    num.innerHTML =
      li.dataset.state === "done"
        ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : String(step);
  });
}

function setFwProgress(fraction: number | null) {
  const visible = fraction !== null;
  $("fw-bar").hidden = !visible;
  $("fw-percent").hidden = !visible;
  if (!visible) return;
  const pct = Math.round(fraction * 100);
  $("fw-fill").style.width = `${pct}%`;
  $("fw-bar").setAttribute("aria-valuenow", String(pct));
  $("fw-percent").textContent = `${pct}%`;
}

async function chooseFirmware(file: File | undefined) {
  firmware = null;
  const verdict = $("fw-verdict");
  $("fw-details").hidden = true;
  verdict.hidden = true;
  if (!file) return;
  $("fw-name").textContent = file.name;
  $("fw-size").textContent = `${file.size.toLocaleString()} bytes`;
  $("fw-choose").textContent = "Choose another file";
  try {
    firmware = await inspectFirmware(new Uint8Array(await file.arrayBuffer()));
    $("fw-package").textContent = firmware.product;
    $("fw-sha").textContent = firmware.sha256;
    $("fw-details").hidden = false;
    verdict.className = `verdict ${firmware.stock ? "good" : "bad"}`;
    verdict.textContent = firmware.stock ? firmware.stock.label : "Not a known stock package";
  } catch (e) {
    verdict.className = "verdict bad";
    verdict.textContent = (e as Error).message;
  }
  verdict.hidden = false;
  refreshControls();
}

const blockUnload = (e: BeforeUnloadEvent) => e.preventDefault();

async function restore() {
  if (!firmware?.stock) return;
  try {
    access ??= await openMidi();
  } catch (e) {
    renderDevice("error", "MIDI unavailable", (e as Error).message);
    return;
  }
  busy = true;
  refreshControls();
  device?.link.close();
  device = null;
  const stage = $("fw-stage");
  stage.className = "stage";
  for (const id of ["fw-box", "fw-confirm-row"]) $(id).hidden = true;
  $("fw-warning").hidden = false;
  setFwProgress(null);
  window.addEventListener("beforeunload", blockUnload);
  try {
    await restoreStockFirmware(firmware, webMidiConnector(access), {
      stage: (s, message) => {
        stage.textContent = message;
        renderSteps(STEP_OF[s]);
        if (s === "writing") setFwProgress(0);
      },
      progress: (f) => setFwProgress(f),
      log,
    });
    stage.className = "stage good";
  } catch (e) {
    const err = e as Error;
    stage.textContent = `Stopped: ${err.message}`;
    stage.className = "stage bad";
    log(`restore failed: ${err.message}${err instanceof RestoreError && err.flashTouched ? " (flash was being written)" : ""}`);
  } finally {
    window.removeEventListener("beforeunload", blockUnload);
    busy = false;
    $("fw-warning").hidden = true;
    for (const id of ["fw-box", "fw-confirm-row"]) $(id).hidden = false;
    $<HTMLInputElement>("fw-confirm").checked = false;
    await connect();
  }
}

// ------------------------------------------------------------------- wiring

const editor = mountEditor({
  library,
  librarySaved: () => {
    saveLibrary(library);
    renderBanks();
  },
  device: () => (device && !busy && !isOtaLoader(device.identity) ? device.link : null),
  download,
});

for (let ch = 1; ch <= 16; ch++) {
  $<HTMLSelectElement>("backup-channel").add(new Option(ch === 1 ? "1 (or All)" : String(ch), String(ch)));
}
BANKS.forEach((b) => $<HTMLSelectElement>("save-bank").add(new Option(b, b)));

$("connect").onclick = connect;
$("read-voice").onclick = readCurrentVoice;
$("save-toggle").onclick = toggleSaveForm;
$("current-edit").onclick = () => capturedVoice && openInEditor(vcedToVmem(capturedVoice), null);
$<HTMLFormElement>("save-form").onsubmit = saveCaptured;
$("backup-all").onclick = backupAll;
$("backup-cancel").onclick = () => backupAbort?.abort();
$("backup-download").onclick = downloadLibrary;
$<HTMLInputElement>("import-all").onchange = (e) => importFile((e.target as HTMLInputElement).files?.[0], "A");
$<HTMLInputElement>("fw-file").onchange = (e) => chooseFirmware((e.target as HTMLInputElement).files?.[0]);
$("fw-confirm").onchange = refreshControls;
$("fw-start").onclick = restore;
window.addEventListener("hashchange", showView);

showView();
renderDevice("off", "Not connected");
renderSteps(0);
renderBackupSummary();
renderBanks();
