/*
 * Claudian Statusline – Sidecar-Plugin
 * ------------------------------------
 * Zeigt eine kompakte, zweizeilige Statusline oberhalb des Claudian-
 * Eingabefelds an (links von "New tab"/"Chat history"):
 *   Zeile 1: 5h-/7d-Rate-Limit inkl. Reset-Zeitpunkt (Tab-unabhängig)
 *   Zeile 2: Kontext-% sowie In-/Out-Token für den gerade aktiven Claudian-Tab
 *
 * Bewusst als eigenständiges Plugin gebaut, das NICHTS an Claudian selbst
 * verändert:
 *   - Datenquellen sind ausschließlich Dateien, die Claude Code bzw.
 *     Claudian ohnehin selbst schreiben (~/.claude/statusline-cache.json,
 *     <Vault>/.obsidian/plugins/realclaudian/data.json,
 *     <Vault>/.claudian/sessions/<conversationId>.meta.json).
 *   - Die Statusline wird per DOM-Injection in Claudians eigene Nav-Row
 *     eingehängt (Selektoren .claudian-input-nav-content /
 *     .claudian-tab-bar-container), nicht per Patch von main.js.
 *   - Deaktivieren/Entfernen dieses Plugins hinterlässt Claudian unverändert.
 *
 * Risiko (bewusst in Kauf genommen, siehe README): Wenn ein Claudian-Update
 * diese CSS-Klassennamen oder die genannten JSON-Dateiformate ändert, bleibt
 * die Statusline schlicht leer/unsichtbar – es wird nirgends hart
 * durchgereicht, alles läuft über try/catch mit stillem Fallback.
 *
 * Optionale Ausnahme von "nur lokale Dateien lesen": Wer die Live-Rate-
 * Limit-Abfrage einschaltet (Einstellungen, standardmäßig AUS), nutzt einen
 * von Anthropic nicht offiziell dokumentierten Endpunkt
 * (api.anthropic.com/api/oauth/usage) mit dem ohnehin von Claude Code
 * gespeicherten OAuth-Token aus ~/.claude/.credentials.json. Kein Token-
 * Verbrauch, aber "inoffiziell" heißt: kann jederzeit ohne Ankündigung
 * brechen – bei Fehlern fällt der Code automatisch auf die Datei-basierten
 * Werte zurück.
 */

const { Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_SETTINGS = {
  claudeDir: "", // leer = Standard ~/.claude verwenden
  refreshSeconds: 5,
  showRateLimits: true,
  showContext: true,
  fontSize: 11, // px
  // "off" = nur Text, "additional" = Balken zusätzlich zur %-Zahl,
  // "replace" = Balken statt %-Zahl
  progressBarMode: "off",
  thresholdOrange: 70, // 5h-/7d-Balken: ab hier orange (%)
  thresholdRed: 90, // 5h-/7d-Balken: ab hier rot (%)
  // Ctx-Balken: eigene, unabhängige Farbbasis – entweder wie 5h/7d anhand
  // eines %-Werts, oder anhand der absoluten Tokenzahl (funktioniert auch im
  // "live, vorläufig"-Fallback, wo noch gar kein % bekannt ist).
  ctxColorMode: "percent", // "percent" | "tokens"
  ctxThresholdOrangePct: 70,
  ctxThresholdRedPct: 90,
  ctxThresholdOrangeTokens: 120000,
  ctxThresholdRedTokens: 170000,
  // Nur bei ctxColorMode "tokens" relevant: statt des von Claudian
  // gemeldeten echten %-Werts (bezogen aufs tatsächliche Kontextfenster) die
  // angezeigte %-Zahl auf den eigenen Rot-Schwellwert normieren (100 % =
  // eigener Warnwert) – kann dann bewusst über 100 % steigen, siehe
  // ctxCustomPercent(). Opt-in, damit sich für Bestandsnutzer nichts
  // stillschweigend ändert.
  ctxNormalizePercent: false,
  useLiveRateLimitApi: false, // inoffizieller Endpunkt, siehe oben – standardmäßig aus
  // Aktivitätsgetrieben statt Dauerpolling (siehe noteActivity):
  // liveApiRefreshSeconds gilt nur, SOLANGE gerade Traffic läuft.
  liveApiRefreshSeconds: 30,
  liveApiIdleStopSeconds: 20, // Ruhezeit ohne Datei-Aktivität, bis das Polling wieder pausiert
  debugLogging: false, // ausführliche Konsolen-Logs zur Fehlersuche (Aktualisierungszyklen, Live-API-Rohantworten)
};

const CLAUDIAN_PLUGIN_ID = "realclaudian";
const LIVE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const NAV_CONTENT_SELECTOR = ".claudian-input-nav-content";
const TAB_BAR_SELECTOR = ".claudian-tab-bar-container";
// Ab Claudian 2.2.x liegt der Tab-Status nicht mehr zentral in der
// data.json des Plugins ("tabManagerState"), sondern je Leaf/Pane als
// Obsidian-View-State in workspace.json, unter dem View-Typ "claudian-view"
// und dort im Feld "tabWorkspace" (siehe findClaudianTabWorkspace()). Beide
// Anker werden unterstützt (neu zuerst, alt als Fallback), falls Claudian
// die Migration noch nicht durchgeführt hat oder erneut umbaut.
const CLAUDIAN_VIEW_TYPE = "claudian-view";
// Ab Claudian 2.2.5 liegen neue *.meta.json-Dateien nicht mehr flach unter
// .claudian/sessions/, sondern je Gerät unter
// .claudian/sessions/devices/device-<Hash>/ (siehe findMetaFilePath()).
const SESSIONS_DEVICES_SUBDIR = "devices";
const WEEKDAYS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// Erlaubt bei Token-Schwellwert-Eingaben neben exakten Zahlen ("120000")
// auch Kurzschreibweisen ("120k"/"120K", "1M", "0,14M"/"0.14M" – sowohl mit
// Komma als auch Punkt als Dezimaltrennzeichen). Gibt bei ungültiger Eingabe
// null zurück (Aufrufer fällt dann auf den bisherigen/Standard-Wert zurück).
function parseTokenAmount(input) {
  if (input == null) return null;
  const s = String(input).trim().replace(",", ".");
  const match = s.match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const suffix = match[2].toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const result = Math.round(num * multiplier);
  return result >= 0 ? result : null;
}

module.exports = class ClaudianStatuslinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ClaudianStatuslineSettingTab(this.app, this));

    this.statusEls = new Set(); // von uns injizierte Wrapper-Elemente
    this.observer = null;
    this.scanDebounceTimer = null;
    this.fsWatchers = new Map(); // Verzeichnis-Pfad -> fs.FSWatcher
    this.fsRefreshTimer = null;

    // Live-Rate-Limit-Abfrage (inoffizieller Endpunkt, siehe Dateikopf) –
    // standardmäßig aus, aktivitätsgetrieben statt Dauerpolling (siehe
    // noteActivity/endLiveApiBurst weiter unten).
    this.liveApiIntervalId = null;
    this.liveApiIdleTimer = null;
    this.liveApiActive = false;
    this.liveApiFetchInFlight = false;
    this.liveRateLimitData = null;
    this.liveRateLimitError = null;

    this.app.workspace.onLayoutReady(() => {
      this.startWatching();
      // Einmaliger Initial-Abruf für sofortige Anzeige beim Start – danach
      // nur noch bei erkannter Aktivität (kein Dauerpolling im Leerlauf).
      if (this.settings.useLiveRateLimitApi) this.fetchLiveRateLimits();
    });

    this.addCommand({
      id: "claudian-statusline-refresh-now",
      name: "Statusline jetzt aktualisieren (Debug)",
      callback: () => {
        this.log("Manuelle Aktualisierung ausgelöst.");
        this.refreshAll();
      },
    });
  }

  // Nur bei aktivem "Debug-Logging"-Schalter (Einstellungen) – für die
  // Fehlersuche bei "Werte aktualisieren sich nicht automatisch". Fehler
  // werden unabhängig davon immer geloggt (siehe logError).
  log(...args) {
    if (this.settings.debugLogging) console.log("[Claudian Statusline]", ...args);
  }

  logError(...args) {
    console.error("[Claudian Statusline]", ...args);
  }

  onunload() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scanDebounceTimer) {
      clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = null;
    }
    if (this.fsRefreshTimer) {
      clearTimeout(this.fsRefreshTimer);
      this.fsRefreshTimer = null;
    }
    if (this.fsWatchers) {
      for (const watcher of this.fsWatchers.values()) {
        try {
          watcher.close();
        } catch (e) {
          // ignorieren – Watcher war ggf. schon tot
        }
      }
      this.fsWatchers.clear();
    }
    this.stopLiveApi();
    for (const wrapper of this.statusEls) {
      const navEl = wrapper.parentElement;
      if (navEl) delete navEl.dataset.claudianStatuslineAttached;
      wrapper.remove();
    }
    this.statusEls.clear();
  }

  // ---------- Live-Rate-Limit-Abfrage (optional, inoffiziell, aktivitätsgetrieben) ----------
  //
  // Statt permanent alle X Sekunden zu pollen (auch im Leerlauf, ohne dass
  // sich etwas ändert), wird der Endpunkt nur abgefragt, WÄHREND gerade
  // wirklich Claude-Traffic läuft – egal ob über Claudian in diesem Vault
  // oder über eine `claude`-Terminal-CLI-Session irgendwo auf dieser
  // Maschine. Erkannt wird das über die ohnehin vorhandenen fs.watch-
  // Beobachter auf ".claudian/sessions", dem Projekt-Transkript-Verzeichnis,
  // ~/.claude selbst (statusline-cache.json) und ~/.claude/sessions/
  // (globale Session-Registry, siehe setupFsWatchers) – jeder Schreibzugriff
  // dort gilt als "Aktivität":
  //   1. Erste Aktivität → sofortiger Abruf + Interval-Polling (Sekunden
  //      aus liveApiRefreshSeconds), solange weitere Aktivität reinkommt.
  //   2. Kommt für liveApiIdleStopSeconds keine weitere Aktivität mehr rein
  //      (Turn vermutlich abgeschlossen) → ein letzter Abruf für den
  //      finalen Stand, danach Polling wieder aus, bis zur nächsten
  //      Aktivität.
  // Während des Leerlaufs bleiben die zuletzt abgerufenen Werte stehen –
  // das ist unproblematisch, weil sich das Rate-Limit ohne eigene Nutzung
  // ohnehin nicht ändert (abgesehen vom Reset-Zeitpunkt, der als fester
  // Text angezeigt wird, nicht live hochgezählt).

  noteActivity() {
    if (!this.settings.useLiveRateLimitApi) return;

    if (this.liveApiIdleTimer) clearTimeout(this.liveApiIdleTimer);

    if (!this.liveApiActive) {
      this.liveApiActive = true;
      this.log("Aktivität erkannt (Claudian oder CLI), starte Live-Rate-Limit-Polling …");
      this.fetchLiveRateLimits();
      const seconds = Math.max(15, this.settings.liveApiRefreshSeconds || DEFAULT_SETTINGS.liveApiRefreshSeconds);
      this.liveApiIntervalId = window.setInterval(() => this.fetchLiveRateLimits(), seconds * 1000);
    }

    const idleSeconds = Math.max(5, this.settings.liveApiIdleStopSeconds || DEFAULT_SETTINGS.liveApiIdleStopSeconds);
    this.liveApiIdleTimer = window.setTimeout(() => this.endLiveApiBurst(), idleSeconds * 1000);
  }

  endLiveApiBurst() {
    if (this.liveApiIntervalId) {
      clearInterval(this.liveApiIntervalId);
      this.liveApiIntervalId = null;
    }
    this.liveApiIdleTimer = null;
    this.liveApiActive = false;
    this.log("Keine Aktivität mehr erkannt, Live-Polling pausiert (letzter Abruf für finalen Stand) …");
    this.fetchLiveRateLimits();
  }

  // Restart des laufenden Intervalls mit neuem liveApiRefreshSeconds-Wert,
  // falls gerade ein Polling-Burst aktiv ist (sonst wirkt die Änderung
  // ohnehin erst beim nächsten Aktivitäts-Start).
  restartLiveApiIntervalIfActive() {
    if (!this.liveApiActive) return;
    if (this.liveApiIntervalId) clearInterval(this.liveApiIntervalId);
    const seconds = Math.max(15, this.settings.liveApiRefreshSeconds || DEFAULT_SETTINGS.liveApiRefreshSeconds);
    this.liveApiIntervalId = window.setInterval(() => this.fetchLiveRateLimits(), seconds * 1000);
  }

  stopLiveApi(resetData = true) {
    if (this.liveApiIntervalId) {
      clearInterval(this.liveApiIntervalId);
      this.liveApiIntervalId = null;
    }
    if (this.liveApiIdleTimer) {
      clearTimeout(this.liveApiIdleTimer);
      this.liveApiIdleTimer = null;
    }
    this.liveApiActive = false;
    if (resetData) {
      this.liveRateLimitData = null;
      this.liveRateLimitError = null;
    }
  }

  async fetchLiveRateLimits() {
    if (this.liveApiFetchInFlight) return;
    this.liveApiFetchInFlight = true;
    this.log("Live-Rate-Limit-Abfrage gestartet …");
    try {
      const credsFile = path.join(this.getClaudeDir(), ".credentials.json");
      const creds = this.readJsonSafe(credsFile);
      const token = creds && creds.claudeAiOauth && creds.claudeAiOauth.accessToken;
      if (!token) {
        this.liveRateLimitError = "Kein OAuth-Token in .credentials.json gefunden";
        this.logError(this.liveRateLimitError, "Datei:", credsFile);
        return;
      }

      const res = await requestUrl({
        url: LIVE_USAGE_URL,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        throw: false,
      });

      if (res.status !== 200) {
        this.liveRateLimitError = `Live-API antwortet mit HTTP ${res.status}`;
        this.logError(this.liveRateLimitError, "Rohantwort:", res.text);
        return;
      }

      const json = res.json;
      const five = (json && json.five_hour) || {};
      const week = (json && json.seven_day) || {};
      // Die echte (undokumentierte) Antwort liefert den Prozentwert unter
      // "utilization" (0–100), nicht unter "used_percentage" – per Debug-Log
      // an einer echten Antwort verifiziert (2026-08-05). Beide Feldnamen
      // werden unterstützt, falls sich das künftig nochmal ändert oder je
      // nach Account-Typ unterschiedlich ist.
      const fiveRaw = five.utilization != null ? five.utilization : five.used_percentage;
      const weekRaw = week.utilization != null ? week.utilization : week.used_percentage;
      const fivePct = this.pctNumber(fiveRaw);
      const weekPct = this.pctNumber(weekRaw);

      // Absicherung: Antwortet der Endpunkt mit HTTP 200, aber in einem
      // Format, in dem wir gar keinen Prozentwert finden (z. B. weil sich
      // das Format erneut geändert hat), NICHT als gültige Live-Daten
      // übernehmen – sonst hätten "leere" Live-Daten trotzdem Vorrang vor
      // dem funktionierenden Datei-Fallback (siehe getRateLimitData) und
      // Zeile 1 würde dauerhaft nur "–" zeigen.
      if (fivePct == null && weekPct == null) {
        this.liveRateLimitError = "Live-API: unerwartetes Antwortformat (utilization/used_percentage fehlt)";
        this.liveRateLimitData = null;
        this.logError(this.liveRateLimitError, "Rohantwort-JSON:", json);
        return;
      }

      this.liveRateLimitData = {
        ok: true,
        five: { pctNum: fivePct, pctStr: this.roundPct(fiveRaw), resetStr: this.formatResetTime(five.resets_at) },
        week: { pctNum: weekPct, pctStr: this.roundPct(weekRaw), resetStr: this.formatResetTime(week.resets_at) },
      };
      this.liveRateLimitError = null;
      this.log("Live-Rate-Limit-Abfrage erfolgreich:", this.liveRateLimitData);
    } catch (e) {
      this.liveRateLimitError = `Live-API-Fehler: ${e && e.message ? e.message : e}`;
      this.logError(this.liveRateLimitError, e);
    } finally {
      this.liveApiFetchInFlight = false;
      this.refreshAll();
    }
  }

  // ---------- Einhängen in die Claudian-Oberfläche ----------

  startWatching() {
    this.scanForComposers();

    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.body, { childList: true, subtree: true });

    // Primärer Auslöser: fs.watch auf den relevanten Verzeichnissen – reagiert
    // quasi sofort (inotify unter Linux), sobald Claude Code/Claudian eine der
    // Quelldateien schreibt.
    this.setupFsWatchers();

    // Sicherheitsnetz: falls fs.watch auf einem Verzeichnis (noch) nicht
    // greift (z. B. weil es beim Plugin-Start noch nicht existierte) oder ein
    // Event verloren geht, wird trotzdem spätestens alle refreshSeconds neu
    // gelesen. Versucht dabei auch gleich, fehlende Watcher nachzurüsten.
    const intervalId = window.setInterval(() => {
      this.log("Timer-Fallback: setupFsWatchers() + refreshAll()", new Date().toLocaleTimeString());
      this.setupFsWatchers();
      this.refreshAll();
    }, Math.max(2, this.settings.refreshSeconds) * 1000);
    this.registerInterval(intervalId);
  }

  // Beobachtet die Verzeichnisse (nicht rekursiv, gezielt die relevanten
  // Ordner) mit dem nativen fs.watch (inotify unter Linux) und stößt bei
  // jeder Änderung eine (debouncte) Aktualisierung an. Fehlt ein Verzeichnis
  // noch (z. B. weil in diesem Tab noch nie eine Nachricht gesendet wurde),
  // wird der Versuch beim nächsten Interval-Tick automatisch wiederholt.
  setupFsWatchers() {
    const claudeDir = this.getClaudeDir();
    const vaultBase = this.getVaultBasePath();

    // isActivitySource = true für Verzeichnisse, deren Änderungen auf
    // laufenden Claude-Traffic hindeuten – das triggert zusätzlich die
    // aktivitätsgetriebene Live-API (siehe noteActivity). Zwei
    // Quellen dafür:
    //   1. Claudian-Traffic in diesem Vault (Session-Meta/Transkript)
    //   2. JEDE aktive `claude`-Terminal-CLI-Session, unabhängig von Vault
    //      oder Projekt: ~/.claude selbst (dort landet statusline-cache.json,
    //      die die CLI bei jeder eigenen Statusline-Aktualisierung berührt)
    //      und ~/.claude/sessions/ (globale, prozessweite Session-Registry
    //      für alle laufenden Claude-Code-Prozesse, CLI wie SDK, egal in
    //      welchem Projekt).
    // Nur Claudians eigene data.json (ändert sich z. B. schon beim bloßen
    // Tab-Wechsel, ohne echten Traffic) bleibt bewusst ausgenommen.
    const targets = [
      { dir: claudeDir, isActivitySource: true },
      { dir: path.join(claudeDir, "sessions"), isActivitySource: true },
    ];
    if (vaultBase) {
      targets.push({
        dir: path.join(vaultBase, ".obsidian", "plugins", CLAUDIAN_PLUGIN_ID),
        isActivitySource: false,
      });
      const claudianSessionsDir = path.join(vaultBase, ".claudian", "sessions");
      targets.push({ dir: claudianSessionsDir, isActivitySource: true });
      targets.push({ dir: this.resolveProjectDir(claudeDir, vaultBase), isActivitySource: true });

      // Geräte-gebundene Unterordner (siehe findMetaFilePath/
      // SESSIONS_DEVICES_SUBDIR) einzeln beobachten: fs.watch auf
      // claudianSessionsDir oben ist bewusst NICHT rekursiv, würde Schreib-
      // zugriffe dort also sonst verpassen und erst beim nächsten
      // Timer-Fallback-Tick bemerken.
      try {
        const devicesDir = path.join(claudianSessionsDir, SESSIONS_DEVICES_SUBDIR);
        if (fs.existsSync(devicesDir)) {
          for (const entry of fs.readdirSync(devicesDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              targets.push({ dir: path.join(devicesDir, entry.name), isActivitySource: true });
            }
          }
        }
      } catch (e) {
        // Lesefehler/Rennen beim Auflisten – nächster Timer-Tick versucht es
        // erneut, der Timer-Fallback greift bis dahin ohnehin.
      }
    }

    for (const { dir, isActivitySource } of targets) {
      if (this.fsWatchers.has(dir)) continue;
      try {
        if (!fs.existsSync(dir)) continue;
        const watcher = fs.watch(dir, { persistent: false }, () => {
          this.scheduleFsRefresh();
          if (isActivitySource) this.noteActivity();
        });
        watcher.on("error", () => {
          try {
            watcher.close();
          } catch (e) {
            // ignorieren
          }
          this.fsWatchers.delete(dir);
        });
        this.fsWatchers.set(dir, watcher);
      } catch (e) {
        // Verzeichnis (noch) nicht beobachtbar – nächster Interval-Tick
        // versucht es erneut, der Timer-Fallback greift bis dahin ohnehin.
      }
    }
  }

  scheduleFsRefresh() {
    this.log("fs.watch-Event erkannt, Aktualisierung geplant …", new Date().toLocaleTimeString());
    if (this.fsRefreshTimer) clearTimeout(this.fsRefreshTimer);
    // Mehrere Datei-Events (z. B. Cache + Meta gleichzeitig geschrieben)
    // kurz einsammeln, statt mehrfach hintereinander neu zu rendern.
    this.fsRefreshTimer = setTimeout(() => this.refreshAll(), 200);
  }

  scheduleScan() {
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
    this.scanDebounceTimer = setTimeout(() => this.scanForComposers(), 200);
  }

  scanForComposers() {
    try {
      const navEls = document.querySelectorAll(NAV_CONTENT_SELECTOR);
      navEls.forEach((navEl) => {
        if (navEl.dataset.claudianStatuslineAttached === "1") return;
        this.attachStatusline(navEl);
      });
    } catch (e) {
      console.error("[Claudian Statusline] Fehler beim Suchen nach Composer-Elementen:", e);
    }
  }

  attachStatusline(navEl) {
    try {
      const tabBarEl = navEl.querySelector(TAB_BAR_SELECTOR);

      const wrapper = document.createElement("div");
      wrapper.className = "claudian-statusline";

      const row1 = document.createElement("div");
      row1.className = "claudian-statusline-row claudian-statusline-row-limits";

      const row2 = document.createElement("div");
      row2.className = "claudian-statusline-row claudian-statusline-row-context";

      wrapper.appendChild(row1);
      wrapper.appendChild(row2);

      if (tabBarEl && tabBarEl.parentElement === navEl) {
        navEl.insertBefore(wrapper, tabBarEl);
      } else {
        navEl.insertBefore(wrapper, navEl.firstChild);
      }

      navEl.dataset.claudianStatuslineAttached = "1";
      wrapper._row1 = row1;
      wrapper._row2 = row2;
      this.statusEls.add(wrapper);

      this.refreshOne(wrapper);
    } catch (e) {
      console.error("[Claudian Statusline] Konnte Statusline nicht einhängen:", e);
    }
  }

  // ---------- Aktualisierung ----------

  refreshAll() {
    for (const wrapper of this.statusEls) {
      if (!wrapper.isConnected) {
        this.statusEls.delete(wrapper);
        continue;
      }
      this.refreshOne(wrapper);
    }
  }

  refreshOne(wrapper) {
    wrapper.style.fontSize = `${this.settings.fontSize}px`;

    if (this.settings.showRateLimits) {
      this.renderRateLimitRow(wrapper._row1);
      wrapper._row1.style.display = "";
    } else {
      wrapper._row1.style.display = "none";
    }

    if (this.settings.showContext) {
      this.renderContextRow(wrapper._row2);
      wrapper._row2.style.display = "";
    } else {
      wrapper._row2.style.display = "none";
    }
  }

  // ---------- Zeile 1: 5h-/7d-Rate-Limit (Tab-unabhängig) ----------

  getRateLimitData() {
    // Live-Werte (falls aktiviert und erfolgreich abgefragt) haben Vorrang;
    // sonst automatischer Rückfall auf die Datei-basierten Werte.
    if (this.settings.useLiveRateLimitApi && this.liveRateLimitData) {
      return this.liveRateLimitData;
    }

    const cacheFile = path.join(this.getClaudeDir(), "statusline-cache.json");
    const cache = this.readJsonSafe(cacheFile);
    if (!cache) {
      return { ok: false, message: "5h: – · 7d: – (keine statusline-cache.json gefunden)" };
    }

    const five = cache.five_hour || {};
    const week = cache.seven_day || {};

    return {
      ok: true,
      five: {
        pctNum: this.pctNumber(five.used_percentage),
        pctStr: this.roundPct(five.used_percentage),
        resetStr: this.formatResetTime(five.resets_at),
      },
      week: {
        pctNum: this.pctNumber(week.used_percentage),
        pctStr: this.roundPct(week.used_percentage),
        resetStr: this.formatResetTime(week.resets_at),
      },
    };
  }

  renderRateLimitRow(row1) {
    row1.textContent = "";

    // Dezenter Tooltip-Hinweis, falls Live-API aktiv ist, aber gerade nicht
    // liefert (dann läuft der Fallback auf die Datei-basierten Werte).
    const liveFailingSilently = this.settings.useLiveRateLimitApi && this.liveRateLimitError && !this.liveRateLimitData;
    if (liveFailingSilently) {
      row1.title = `Live-API nicht erreichbar, zeige Datei-basierte Werte: ${this.liveRateLimitError}`;
    } else if (this.settings.useLiveRateLimitApi && this.liveRateLimitData) {
      row1.title = "Live via inoffizielle Anthropic-API abgefragt.";
    } else {
      row1.title = "";
    }

    const data = this.getRateLimitData();
    if (!data.ok) {
      row1.textContent = data.message;
      return;
    }

    const mode = this.settings.progressBarMode;
    const frag = document.createDocumentFragment();

    frag.appendChild(document.createTextNode("5h: "));
    if (mode !== "replace") frag.appendChild(document.createTextNode(`${data.five.pctStr} `));
    if (mode === "additional" || mode === "replace") frag.appendChild(this.createBarEl(data.five.pctNum));
    frag.appendChild(document.createTextNode(` · Reset ${data.five.resetStr}   |   7d: `));
    if (mode !== "replace") frag.appendChild(document.createTextNode(`${data.week.pctStr} `));
    if (mode === "additional" || mode === "replace") frag.appendChild(this.createBarEl(data.week.pctNum));
    frag.appendChild(document.createTextNode(` · Reset ${data.week.resetStr}`));
    if (liveFailingSilently) frag.appendChild(document.createTextNode(" ⚠"));

    row1.appendChild(frag);
  }

  roundPct(value) {
    if (value == null) return "–";
    const n = Number(value);
    return Number.isFinite(n) ? `${Math.round(n)}%` : "–";
  }

  pctNumber(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- Fortschrittsbalken mit Grün/Orange/Rot-Eskalation ----------

  // `color` optional: wird er übergeben, überschreibt er die per pctNum aus
  // den 5h-/7d-Schwellwerten ermittelte Farbe (genutzt vom Ctx-Balken, der
  // seine eigene, unabhängige Farblogik hat, siehe colorForCtx).
  createBarEl(pctNum, color) {
    const bar = document.createElement("span");
    bar.className = "claudian-statusline-bar";

    const fill = document.createElement("span");
    fill.className = "claudian-statusline-bar-fill";
    const clamped = pctNum == null ? 0 : Math.max(0, Math.min(100, pctNum));
    fill.style.width = `${clamped}%`;
    fill.style.backgroundColor = color != null ? color : this.colorForPct(pctNum);
    bar.appendChild(fill);

    return bar;
  }

  // Farblogik für die 5h-/7d-Balken (immer prozentbasiert).
  colorForPct(pctNum) {
    if (pctNum == null) return "var(--background-modifier-border)";
    const { thresholdOrange, thresholdRed } = this.settings;
    if (pctNum >= thresholdRed) return "var(--color-red)";
    if (pctNum >= thresholdOrange) return "var(--color-orange)";
    return "var(--color-green)";
  }

  // Farblogik für den Ctx-Balken – eigene Schwellwerte, wahlweise auf Basis
  // des %-Werts (wie 5h/7d) oder der absoluten Tokenzahl. Letzteres ist der
  // einzige Weg, den Balken auch im "live, vorläufig"-Fallback einzufärben,
  // da dort (noch) kein %-Wert bekannt ist (Kontextfenster erst nach
  // Turn-Abschluss von Claudian bekannt).
  colorForCtx(pctNum, tokens) {
    if (this.settings.ctxColorMode === "tokens") {
      if (tokens == null || !Number.isFinite(tokens)) return "var(--background-modifier-border)";
      const { ctxThresholdOrangeTokens, ctxThresholdRedTokens } = this.settings;
      if (tokens >= ctxThresholdRedTokens) return "var(--color-red)";
      if (tokens >= ctxThresholdOrangeTokens) return "var(--color-orange)";
      return "var(--color-green)";
    }
    if (pctNum == null) return "var(--background-modifier-border)";
    const { ctxThresholdOrangePct, ctxThresholdRedPct } = this.settings;
    if (pctNum >= ctxThresholdRedPct) return "var(--color-red)";
    if (pctNum >= ctxThresholdOrangePct) return "var(--color-orange)";
    return "var(--color-green)";
  }

  // Balkenlänge bei Farbbasis "Tokenzahl": der Rot-Schwellwert wird als
  // "100 % Balkenlänge" normiert (statt des tatsächlichen, meist deutlich
  // größeren Kontextfensters) – so füllt sich der Balken sichtbar in Richtung
  // des selbst gesetzten Warnbereichs, nicht erst nahe der echten 200k-Grenze.
  ctxTokenBarWidthPct(tokens) {
    const redThreshold = this.settings.ctxThresholdRedTokens;
    if (!(redThreshold > 0) || tokens == null || !Number.isFinite(tokens)) return 0;
    return Math.min(100, (tokens / redThreshold) * 100);
  }

  // Gegenstück zu ctxTokenBarWidthPct() für die %-ZAHL statt der Balkenlänge:
  // bewusst NICHT auf 100 gedeckelt (ein Balken kann nicht über den Rand
  // hinaus zeichnen, eine Zahl schon) – wer den eigenen Rot-Schwellwert als
  // "100 %"-Grenze versteht, sieht so auf einen Blick, um wie viel Prozent
  // er diese selbst gesetzte, sichere Grenze bereits überschritten hat (z. B.
  // 118 %), statt dass die Anzeige bei 100 % einfach "steckenbleibt".
  ctxCustomPercent(tokens) {
    const redThreshold = this.settings.ctxThresholdRedTokens;
    if (!(redThreshold > 0) || tokens == null || !Number.isFinite(tokens)) return null;
    return (tokens / redThreshold) * 100;
  }

  formatResetTime(resetsAt) {
    if (resetsAt == null || resetsAt === "") return "–";
    // Die Datei-basierte Quelle liefert Epoch-Sekunden als String/Zahl, die
    // (inoffizielle) Live-API liefert laut Beobachtung ISO-8601 – beides
    // abdecken.
    let d;
    if (typeof resetsAt === "number" || /^\d+$/.test(String(resetsAt).trim())) {
      d = new Date(Number(resetsAt) * 1000);
    } else {
      d = new Date(resetsAt);
    }
    if (isNaN(d.getTime())) return "–";
    const pad = (n) => String(n).padStart(2, "0");
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    const dd = pad(d.getDate());
    const mo = pad(d.getMonth() + 1);
    const yyyy = d.getFullYear();
    return `${hh}:${mm} (${WEEKDAYS_DE[d.getDay()]}, ${dd}.${mo}.${yyyy})`;
  }

  // ---------- Zeile 2: Kontext-%/In-Out für den aktiven Tab ----------

  // Ab Claudian 2.2.5 (per 2026-09-05 an echten Vault-Daten beobachtet) landet
  // die *.meta.json neuer Sessions nicht mehr flach unter
  // .claudian/sessions/<conversationId>.meta.json, sondern geräte-gebunden
  // unter .claudian/sessions/devices/device-<Hash>/<conversationId>.meta.json
  // (vermutlich zur Konfliktvermeidung bei Multi-Geräte-/Sync-Nutzung
  // desselben Vaults). Sessions, die vor diesem Umbau entstanden sind, bleiben
  // an der alten flachen Stelle liegen. Beide Orte werden unterstützt: neuer
  // Ort zuerst (über alle vorhandenen Geräte-Ordner geprüft, da nicht bekannt
  // ist, welcher Hash "dieses" Gerät ist – bei mehreren Treffern gewinnt der
  // zuletzt geänderte), alter flacher Pfad als Fallback.
  findMetaFilePath(vaultBase, conversationId) {
    const sessionsDir = path.join(vaultBase, ".claudian", "sessions");
    const devicesDir = path.join(sessionsDir, SESSIONS_DEVICES_SUBDIR);
    const legacyPath = path.join(sessionsDir, `${conversationId}.meta.json`);

    try {
      if (fs.existsSync(devicesDir)) {
        const candidates = fs
          .readdirSync(devicesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(devicesDir, entry.name, `${conversationId}.meta.json`))
          .filter((p) => fs.existsSync(p));

        if (candidates.length > 1) {
          candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        }
        if (candidates.length > 0) return candidates[0];
      }
    } catch (e) {
      // Lesefehler im devices-Ordner (z. B. Rennen mit einem gerade
      // angelegten Unterordner) – einfach auf den alten Pfad zurückfallen,
      // der Timer-Fallback versucht es beim nächsten Tick erneut.
    }

    return legacyPath;
  }

  getContextData() {
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) return { ok: false, message: "Ctx: – (Vault-Pfad nicht ermittelbar)" };

    const tabState = this.findClaudianTabWorkspace(vaultBase);
    if (!tabState) return { ok: false, message: "Ctx: – (Claudian-Tab-Status nicht gefunden)" };

    const activeTabId = tabState.activeTabId;
    const openTabs = Array.isArray(tabState.openTabs) ? tabState.openTabs : [];
    const activeTab = openTabs.find((t) => t.tabId === activeTabId);
    const conversationId = activeTab && activeTab.conversationId;
    if (!conversationId) return { ok: false, message: "Ctx: – (kein aktiver Tab mit Conversation)" };

    const metaFile = this.findMetaFilePath(vaultBase, conversationId);
    const meta = this.readJsonSafe(metaFile);
    if (!meta) {
      return { ok: false, message: "Ctx: – (kein Meta für diesen Tab gefunden)" };
    }

    // Claudian selbst schreibt das "usage"-Feld in meta.json erst NACH
    // vollständigem Abschluss einer Antwort (empirisch bestätigt: bei einem
    // frisch gestarteten Chat blieb es mehrere Minuten leer, obwohl bereits
    // aktiv generiert wurde). Solange es fehlt (frischer Tab) ODER solange es
    // schlicht VERALTET ist (nächster Turn läuft bereits, oder gerade eben
    // ein "/compact" passiert ist), live aus dem JSONL-Transkript der Session
    // nachrechnen – dieselbe Quelle, aus der auch das portable
    // statusline-viewer-py-Tool liest und die während der Generierung/direkt
    // nach einem Compact bereits aktuell ist.
    //
    // "Veraltet" wird über den Datei-Zeitstempel erkannt, nicht über die
    // Tokenzahl: Ein Compact kann den Tokenverbrauch auch SENKEN statt
    // erhöhen, ein reiner Zahlenvergleich (größer/kleiner) würde das also
    // verpassen. Der Zeitstempel-Vergleich ist dabei robust gegen
    // Schreibreihenfolge-Zufälle, weil Claudian "meta.json" immer erst
    // schreiben KANN, nachdem die zugehörige Transkript-Zeile schon
    // existiert (es liest die Usage-Daten ja erst aus der Antwort, die zuvor
    // schon im JSONL gelandet ist) – ist das JSONL trotzdem neuer als
    // meta.json, ist seit dem letzten meta.json-Schreiben mindestens eine
    // neue Nachricht dazugekommen.
    const liveUsage = this.readLastAssistantUsage(meta.sessionId);
    const liveTokens = liveUsage
      ? (liveUsage.input_tokens || 0) +
        (liveUsage.cache_creation_input_tokens || 0) +
        (liveUsage.cache_read_input_tokens || 0)
      : null;

    let metaUsageStale = false;
    if (meta.usage) {
      try {
        const jsonlFile = this.getSessionJsonlPath(meta.sessionId);
        if (jsonlFile && fs.existsSync(jsonlFile)) {
          const metaMtimeMs = fs.statSync(metaFile).mtimeMs;
          const jsonlMtimeMs = fs.statSync(jsonlFile).mtimeMs;
          if (jsonlMtimeMs > metaMtimeMs) metaUsageStale = true;
        }
      } catch (e) {
        // Bei Stat-Fehlern konservativ dem bisherigen meta.usage vertrauen.
      }
    }

    if (!meta.usage || metaUsageStale) {
      if (liveUsage) {
        return {
          ok: true,
          isLive: true,
          ctxTokensNum: liveTokens,
          ctxTokensStr: this.formatTokens(liveTokens),
          inStr: this.formatTokens(liveTokens),
          outStr: typeof liveUsage.output_tokens === "number" ? this.formatTokens(liveUsage.output_tokens) : "–",
        };
      }
      if (!meta.usage) {
        return { ok: false, message: "Ctx: – (noch keine Nutzungsdaten für diesen Tab)" };
      }
      // liveUsage nicht lesbar (z. B. Transkript-Datei kurzzeitig nicht
      // auffindbar) – dann lieber die zwar potenziell veralteten, aber
      // vorhandenen meta.usage-Werte zeigen als "–" (fällt unten durch).
    }

    const usage = meta.usage;
    const pctNum = usage.percentage != null ? Number(usage.percentage) : null;
    const ctxTokens = usage.contextTokens;
    const ctxWindow = usage.contextWindow;
    const inTokens =
      (usage.inputTokens || 0) + (usage.cacheCreationInputTokens || 0) + (usage.cacheReadInputTokens || 0);
    const outTokens = liveUsage && typeof liveUsage.output_tokens === "number" ? liveUsage.output_tokens : null;

    return {
      ok: true,
      isLive: false,
      pctNum: Number.isFinite(pctNum) ? pctNum : null,
      pctStr: pctNum != null ? `${Math.round(pctNum)}%` : "–",
      ctxTokensNum: typeof ctxTokens === "number" && Number.isFinite(ctxTokens) ? ctxTokens : null,
      ctxStr:
        ctxTokens != null && ctxWindow ? `${this.formatTokens(ctxTokens)}/${this.formatTokens(ctxWindow)}` : "–",
      inStr: this.formatTokens(inTokens),
      outStr: outTokens != null ? this.formatTokens(outTokens) : "–",
    };
  }

  renderContextRow(row2) {
    row2.textContent = "";
    row2.title = "";
    const data = this.getContextData();
    this.log("renderContextRow():", new Date().toLocaleTimeString(), data);
    if (!data.ok) {
      row2.textContent = data.message;
      return;
    }

    const frag = document.createDocumentFragment();

    const mode = this.settings.progressBarMode;
    // Nur bei Farbbasis "Tokenzahl" sinnvoll: die angezeigte %-Zahl auf den
    // eigenen Rot-Schwellwert normieren (100 % = eigener Warnwert) statt den
    // echten, von Claudian gemeldeten %-Wert zu zeigen – siehe
    // ctxCustomPercent(). Kann bewusst über 100 % steigen.
    const useCustomPercent = this.settings.ctxColorMode === "tokens" && this.settings.ctxNormalizePercent;

    if (data.isLive) {
      // Vorläufige, live aus dem JSONL-Transkript berechnete Werte (siehe
      // getContextData) – ohne eigene Normierung noch keine %-Angabe möglich,
      // da Claudian das Kontextfenster/die %-Berechnung erst nach
      // Turn-Abschluss liefert. Ein Balken lässt sich hier trotzdem zeigen,
      // sofern die Ctx-Farbbasis auf "Tokenzahl" steht (siehe
      // ctxTokenBarWidthPct) – bei Farbbasis "Prozent" bleibt der Balken hier
      // weiterhin aus, da dafür schlicht kein %-Wert existiert.
      const customPctNum = useCustomPercent ? this.ctxCustomPercent(data.ctxTokensNum) : null;
      const customPctSuffix = customPctNum != null ? ` (${Math.round(customPctNum)}%)` : "";
      frag.appendChild(document.createTextNode(`Ctx: ~${data.ctxTokensStr}${customPctSuffix} (live, vorläufig) `));
      if (mode !== "off" && this.settings.ctxColorMode === "tokens") {
        const widthPct = this.ctxTokenBarWidthPct(data.ctxTokensNum);
        const color = this.colorForCtx(null, data.ctxTokensNum);
        frag.appendChild(this.createBarEl(widthPct, color));
        frag.appendChild(document.createTextNode(" "));
      }
      frag.appendChild(document.createTextNode(`· In: ${data.inStr} · Out: ${data.outStr}`));
      if (customPctNum != null) {
        row2.title = `Auf eigenen Rot-Schwellwert normierter Wert (100 % = ${this.formatTokens(
          this.settings.ctxThresholdRedTokens
        )}). Echter %-Wert lt. Claudian liegt hier noch nicht vor (Antwort läuft noch).`;
      }
    } else {
      const color = this.colorForCtx(data.pctNum, data.ctxTokensNum);
      // Balkenlänge (nicht nur Farbe!) richtet sich bei Farbbasis "Tokenzahl"
      // ebenfalls nach dem Rot-Schwellwert statt nach dem echten, von
      // Claudian gemeldeten %-Wert – der Rot-Schwellwert entspricht dann
      // also "100 % Balkenlänge", unabhängig vom tatsächlichen Kontextfenster.
      const barWidthPct =
        this.settings.ctxColorMode === "tokens" ? this.ctxTokenBarWidthPct(data.ctxTokensNum) : data.pctNum;
      // Anders als die Balkenlänge wird die %-ZAHL hier bewusst NICHT auf 100
      // gedeckelt (siehe ctxCustomPercent) – so ist sichtbar, um wie viel man
      // den eigenen Warnwert bereits überschritten hat, statt dass die
      // Anzeige bei 100 % steckenbleibt.
      const customPctNum = useCustomPercent ? this.ctxCustomPercent(data.ctxTokensNum) : null;
      const displayPctStr = customPctNum != null ? `${Math.round(customPctNum)}%` : data.pctStr;
      frag.appendChild(document.createTextNode("Ctx: "));
      if (mode !== "replace") frag.appendChild(document.createTextNode(`${displayPctStr} `));
      if (mode === "additional" || mode === "replace") frag.appendChild(this.createBarEl(barWidthPct, color));
      frag.appendChild(
        document.createTextNode(` (${data.ctxStr}) · In: ${data.inStr} · Out: ${data.outStr}`)
      );
      if (customPctNum != null) {
        row2.title = `Auf eigenen Rot-Schwellwert normiert (100 % = ${this.formatTokens(
          this.settings.ctxThresholdRedTokens
        )}). Echter %-Wert lt. Claudian: ${data.pctStr}.`;
      }
    }

    row2.appendChild(frag);
  }

  formatTokens(n) {
    if (n == null || !Number.isFinite(n)) return "–";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
    return String(n);
  }

  // Ermittelt den Projekt-Transkript-Ordner (~/.claude/projects/<sanitizer
  // Vault-Pfad>/), den Claude Code selbst anlegt, indem es jedes
  // Nicht-alphanumerische Zeichen im absoluten Arbeitsverzeichnis-Pfad durch
  // "-" ersetzt. Auf Linux gegen echte Daten verifiziert – unter Windows
  // (ungetestet!) gibt es dabei mehrere Unsicherheiten, die zu einem
  // abweichenden Ordnernamen führen könnten:
  //   - Groß-/Kleinschreibung des Laufwerksbuchstabens ("C:" vs. "c:")
  //   - ob Obsidians adapter.basePath Backslashes oder (seltener) Slashes
  //     liefert
  //   - ein eventueller abschließender Pfadtrenner
  // Statt uns auf genau eine Variante zu verlassen, werden mehrere
  // plausible Kandidaten gebildet und der erste GENOMMEN, der tatsächlich
  // auf der Platte existiert. Schlägt das fehl (z. B. weil noch nie ein
  // Gespräch in diesem Vault stattfand), wird trotzdem der Standard-
  // Kandidat zurückgegeben – der Timer-Fallback versucht es bei jedem Tick
  // erneut, sobald der Ordner existiert.
  resolveProjectDir(claudeDir, vaultBase) {
    const cacheKey = `${claudeDir}|${vaultBase}`;
    if (
      this._projectDirCache &&
      this._projectDirCache.key === cacheKey &&
      fs.existsSync(this._projectDirCache.dir)
    ) {
      return this._projectDirCache.dir;
    }

    const rawVariants = new Set([vaultBase, vaultBase.replace(/[\\/]+$/, "")]);
    if (process.platform === "win32") {
      rawVariants.add(vaultBase.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ":"));
      rawVariants.add(vaultBase.replace(/^([a-zA-Z]):/, (_, d) => d.toLowerCase() + ":"));
    }
    // Backslash/Slash-getauschte Variante schadet auf Linux/macOS nicht
    // (existiert dort schlicht nicht) und deckt Electron-Eigenheiten ab.
    for (const v of Array.from(rawVariants)) {
      rawVariants.add(v.replace(/\\/g, "/"));
      rawVariants.add(v.replace(/\//g, "\\"));
    }

    const sanitizedSet = new Set(Array.from(rawVariants).map((v) => v.replace(/[^A-Za-z0-9]/g, "-")));
    const candidates = Array.from(sanitizedSet).map((s) => path.join(claudeDir, "projects", s));

    let found = candidates.find((dir) => fs.existsSync(dir));
    if (found) {
      this.log("Projekt-Verzeichnis aufgelöst:", found);
    } else {
      found = candidates[0];
      this.log("Kein existierendes Projekt-Verzeichnis unter den Kandidaten, nutze Standard:", found, "Kandidaten:", candidates);
    }
    this._projectDirCache = { key: cacheKey, dir: found };
    return found;
  }

  // Pfad zum JSONL-Transkript einer Session (siehe resolveProjectDir) – von
  // readLastAssistantUsage() UND dem Veraltet-Check in getContextData()
  // genutzt, daher als eigener Helper statt dupliziert.
  getSessionJsonlPath(sessionId) {
    if (!sessionId) return null;
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) return null;
    const projectDir = this.resolveProjectDir(this.getClaudeDir(), vaultBase);
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  // Das komplette "usage"-Objekt (input_tokens, cache_*, output_tokens) der
  // letzten Assistant-Nachricht steht nicht in meta.json, sondern nur im
  // JSONL-Transkript der zugrundeliegenden Claude-Code-Session (gleiche
  // Ablage wie beim CLI, siehe resolveProjectDir).
  // Wird sowohl für Out (immer) als auch als Live-Fallback für Ctx/In
  // genutzt, solange Claudian selbst noch kein aktuelles meta.json-"usage"
  // geschrieben hat (siehe getContextData, inkl. Veraltet-Erkennung).
  readLastAssistantUsage(sessionId) {
    const jsonlFile = this.getSessionJsonlPath(sessionId);
    if (!jsonlFile) return null;

    try {
      if (!fs.existsSync(jsonlFile)) return null;
      const lines = this.tailLines(jsonlFile, 60);
      let lastUsage = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch (e) {
          continue;
        }
        if (obj.type !== "assistant" || obj.isSidechain === true) continue;
        const usage = obj.message && obj.message.usage;
        if (usage) lastUsage = usage;
      }
      return lastUsage;
    } catch (e) {
      return null;
    }
  }

  // Liest effizient nur die letzten n Zeilen einer (potenziell großen) Datei,
  // ohne sie komplett einzulesen – Entsprechung zu `tail -n`.
  tailLines(filePath, n) {
    const blockSize = 65536;
    const fd = fs.openSync(filePath, "r");
    try {
      const stat = fs.fstatSync(fd);
      let position = stat.size;
      let data = Buffer.alloc(0);
      let newlineCount = 0;

      while (position > 0 && newlineCount <= n) {
        const readSize = Math.min(blockSize, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);
        data = Buffer.concat([buf, data]);

        newlineCount = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] === 10) newlineCount++;
        }
      }

      return data.toString("utf-8").split("\n").slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  }

  // ---------- Hilfsfunktionen ----------

  // Liefert { activeTabId, openTabs: [{tabId, conversationId}, ...] } oder
  // null, egal ob Claudian den Tab-Status (noch) zentral in seiner data.json
  // ablegt oder (ab 2.2.x) je Leaf/Pane als eigenen View-State in
  // workspace.json. Reihenfolge: neuer Anker zuerst, alter als Fallback
  // (z. B. während/vor Claudians eigener Migration).
  findClaudianTabWorkspace(vaultBase) {
    const fromWorkspace = this.findTabWorkspaceInWorkspaceLayout(vaultBase);
    if (fromWorkspace) return fromWorkspace;
    return this.findLegacyTabManagerState(vaultBase);
  }

  // Neuer Anker (ab Claudian 2.2.x): workspace.json enthält irgendwo im
  // Layout-Baum (main-/left-/right-Split, Floating-Windows – Struktur bewusst
  // NICHT hart verdrahtet, da das Obsidian-interne Schema ist) einen Leaf mit
  // state.type === "claudian-view"; dessen eigener View-State liegt in
  // state.state und trägt dort das Feld "tabWorkspace"
  // ({ version, activeTabId, openTabs: [{tabId, conversationId}] }).
  findTabWorkspaceInWorkspaceLayout(vaultBase) {
    const workspaceFile = path.join(vaultBase, ".obsidian", "workspace.json");
    const workspace = this.readJsonSafe(workspaceFile);
    if (!workspace) return null;

    const found = this.findFirstClaudianViewState(workspace, 0);
    return (found && found.tabWorkspace) || null;
  }

  // Generischer, tiefenbegrenzter Baum-Walk statt hart kodierter
  // children/root/left/right/floating-Pfade: robuster gegen künftige
  // Layout-Umbauten, solange der Leaf selbst weiterhin
  // { type: "claudian-view", state: {...} } trägt.
  findFirstClaudianViewState(node, depth) {
    if (depth > 40 || node == null || typeof node !== "object") return null;

    if (
      Array.isArray(node) === false &&
      node.type === CLAUDIAN_VIEW_TYPE &&
      node.state &&
      typeof node.state === "object"
    ) {
      return node.state;
    }

    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      const found = this.findFirstClaudianViewState(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Alter Anker (vor Claudian 2.2.x bzw. solange Claudians eigene
  // Migration noch nicht gelaufen ist): zentraler Tab-Status in der
  // data.json des Plugins selbst, Feld "tabManagerState".
  findLegacyTabManagerState(vaultBase) {
    const claudianDataFile = path.join(
      vaultBase,
      ".obsidian",
      "plugins",
      CLAUDIAN_PLUGIN_ID,
      "data.json"
    );
    const claudianData = this.readJsonSafe(claudianDataFile);
    return (claudianData && claudianData.tabManagerState) || null;
  }

  getClaudeDir() {
    const override = (this.settings.claudeDir || "").trim();
    if (override) return override;
    return path.join(os.homedir(), ".claude");
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    return adapter && adapter.basePath ? adapter.basePath : null;
  }

  readJsonSafe(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class ClaudianStatuslineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Claudian Statusline" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Eigenständiges Sidecar-Plugin – verändert Claudian selbst nicht. " +
        "Falls nach einem Claudian-Update nichts mehr angezeigt wird, hier " +
        "oder unter Community-Plugins einfach deaktivieren; Claudian bleibt " +
        "davon unberührt.",
    });

    new Setting(containerEl)
      .setName("5h-/7d-Rate-Limit-Zeile anzeigen")
      .setDesc("Tab-unabhängig, aus ~/.claude/statusline-cache.json.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showRateLimits).onChange(async (v) => {
          this.plugin.settings.showRateLimits = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Kontext-%/Token-Zeile anzeigen")
      .setDesc("Bezogen auf den gerade aktiven Claudian-Tab.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showContext).onChange(async (v) => {
          this.plugin.settings.showContext = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Aktualisierungsintervall (Sekunden)")
      .setDesc(
        "Änderungen werden primär sofort per Datei-Überwachung (fs.watch/" +
          "inotify) erkannt. Dieser Wert ist nur das Sicherheitsnetz, falls " +
          "das mal nicht greift – spätestens nach dieser Zeit wird ohnehin " +
          "neu gelesen."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.refreshSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.refreshSeconds =
            Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.refreshSeconds;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Darstellung" });

    new Setting(containerEl)
      .setName("Schriftgröße")
      .setDesc("Textgröße der Statusline in Pixel.")
      .addSlider((s) =>
        s
          .setLimits(9, 20, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Fortschrittsbalken für %-Werte")
      .setDesc(
        "Zusätzlich oder anstelle der %-Zahl je einen kleinen, farbigen Balken " +
          "anzeigen (5h, 7d, Ctx). Farbe wechselt automatisch Grün → Orange → Rot. " +
          "Die Farbschwellwerte für den Ctx-Balken lassen sich unten separat einstellen."
      )
      .addDropdown((d) =>
        d
          .addOption("off", "Aus (nur Text)")
          .addOption("additional", "Zusätzlich zur %-Zahl")
          .addOption("replace", "Statt %-Zahl")
          .setValue(this.plugin.settings.progressBarMode)
          .onChange(async (v) => {
            this.plugin.settings.progressBarMode = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Schwellwert Orange (%) – 5h/7d")
      .setDesc("Gilt nur für die 5h-/7d-Rate-Limit-Balken. Ab diesem Prozentwert färbt sich der Balken orange.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.thresholdOrange)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.thresholdOrange =
            Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_SETTINGS.thresholdOrange;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Schwellwert Rot (%) – 5h/7d")
      .setDesc("Gilt nur für die 5h-/7d-Rate-Limit-Balken. Ab diesem Prozentwert färbt sich der Balken rot.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.thresholdRed)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.thresholdRed =
            Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_SETTINGS.thresholdRed;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    containerEl.createEl("h3", { text: "Ctx-Balken: eigene Farbeinstellung" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Der Ctx-Balken hat eine eigene, vom 5h-/7d-Balken unabhängige " +
        "Farblogik – wahlweise anhand des %-Werts oder anhand der absoluten " +
        "Tokenzahl. Tokenbasiert ist besonders im \"live, vorläufig\"-Zustand " +
        "sinnvoll (frischer Tab oder Antwort läuft noch): Dort ist noch kein " +
        "%-Wert bekannt (Claudian liefert das Kontextfenster erst nach " +
        "Turn-Abschluss) – nur mit Tokenbasis wird der Balken auch dann " +
        "eingefärbt und angezeigt.",
    });

    new Setting(containerEl)
      .setName("Farbbasis für Ctx-Balken")
      .setDesc(
        "\"Prozent\" verhält sich wie beim 5h-/7d-Balken. \"Tokenzahl\" färbt " +
          "anhand der absoluten Anzahl verbrauchter Kontext-Tokens – dein " +
          "Kontextfenster ist meist konstant (z. B. 200k), daher lassen sich " +
          "die Schwellwerte unten einmalig darauf abstimmen."
      )
      .addDropdown((d) =>
        d
          .addOption("percent", "Prozent (wie 5h/7d)")
          .addOption("tokens", "Tokenzahl (absolut)")
          .setValue(this.plugin.settings.ctxColorMode)
          .onChange(async (v) => {
            this.plugin.settings.ctxColorMode = v;
            await this.plugin.saveSettings();
            this.plugin.refreshAll();
          })
      );

    new Setting(containerEl)
      .setName("Ctx-Schwellwert Orange (%)")
      .setDesc("Nur bei Farbbasis \"Prozent\" relevant.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.ctxThresholdOrangePct)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.ctxThresholdOrangePct =
            Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_SETTINGS.ctxThresholdOrangePct;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Ctx-Schwellwert Rot (%)")
      .setDesc("Nur bei Farbbasis \"Prozent\" relevant.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.ctxThresholdRedPct)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.ctxThresholdRedPct =
            Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_SETTINGS.ctxThresholdRedPct;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Ctx-Schwellwert Orange (Tokens)")
      .setDesc(
        "Nur bei Farbbasis \"Tokenzahl\" relevant. Absolute Anzahl Kontext-" +
          "Tokens, ab der orange gefärbt wird. Kurzschreibweisen erlaubt, " +
          "z. B. \"120k\", \"1M\" oder \"0,14M\"."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.ctxThresholdOrangeTokens)).onChange(async (v) => {
          const n = parseTokenAmount(v);
          this.plugin.settings.ctxThresholdOrangeTokens =
            n != null ? n : DEFAULT_SETTINGS.ctxThresholdOrangeTokens;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Ctx-Schwellwert Rot (Tokens)")
      .setDesc(
        "Nur bei Farbbasis \"Tokenzahl\" relevant. Absolute Anzahl Kontext-" +
          "Tokens, ab der rot gefärbt wird. Kurzschreibweisen erlaubt, " +
          "z. B. \"170k\", \"1M\" oder \"0,17M\"."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.ctxThresholdRedTokens)).onChange(async (v) => {
          const n = parseTokenAmount(v);
          this.plugin.settings.ctxThresholdRedTokens =
            n != null ? n : DEFAULT_SETTINGS.ctxThresholdRedTokens;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Ctx-%-Anzeige auf eigenen Rot-Schwellwert normieren")
      .setDesc(
        "Nur bei Farbbasis \"Tokenzahl\" relevant. Statt des von Claudian " +
          "gemeldeten echten %-Werts (bezogen auf das tatsächliche, meist " +
          "deutlich größere Kontextfenster) wird die angezeigte %-Zahl auf " +
          "deinen eigenen Rot-Schwellwert oben normiert – dieser Wert gilt " +
          "dann als \"100 %\". Anders als die Balkenlänge wird diese Zahl " +
          "dabei NICHT gedeckelt: Überschreitest du deinen selbst gesetzten " +
          "Schwellwert, steigt die Anzeige bewusst über 100 % (z. B. 118 %), " +
          "damit sofort sichtbar ist, um wie viel du deinen eigenen, sicher " +
          "geglaubten Rahmen bereits überschritten hast. Der echte %-Wert " +
          "steht weiterhin als Tooltip zur Verfügung."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.ctxNormalizePercent).onChange(async (v) => {
          this.plugin.settings.ctxNormalizePercent = v;
          await this.plugin.saveSettings();
          this.plugin.refreshAll();
        })
      );

    containerEl.createEl("h3", { text: "Live-Rate-Limit-Abfrage (experimentell)" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Fragt 5h-/7d-Nutzung direkt über einen von Anthropic NICHT offiziell " +
        "dokumentierten Endpunkt ab (mit dem bereits gespeicherten OAuth-Token " +
        "aus ~/.claude/.credentials.json). Kostet keine Tokens, ist aber " +
        "inoffiziell und kann jederzeit ohne Ankündigung aufhören zu " +
        "funktionieren – bei Fehlern fällt die Statusline automatisch auf die " +
        "bisherigen, Datei-basierten Werte zurück. Aktivitätsgetrieben statt " +
        "Dauerpolling: Es wird nur abgefragt, während in Claudian gerade " +
        "wirklich etwas passiert – im Leerlauf bleibt der letzte Stand einfach " +
        "stehen (er ändert sich ohne eigene Nutzung ohnehin nicht).",
    });

    new Setting(containerEl)
      .setName("Live-Abfrage aktivieren")
      .setDesc(
        "Standardmäßig aus. Fragt bei Aktivierung sofort einmal ab, danach " +
          "nur noch automatisch, sobald in irgendeinem Claudian-Tab eine " +
          "Anfrage läuft."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.useLiveRateLimitApi).onChange(async (v) => {
          this.plugin.settings.useLiveRateLimitApi = v;
          await this.plugin.saveSettings();
          if (v) {
            this.plugin.fetchLiveRateLimits(); // einmaliger Initial-Abruf
          } else {
            this.plugin.stopLiveApi();
          }
          this.plugin.refreshAll();
        })
      );

    new Setting(containerEl)
      .setName("Poll-Intervall während aktiver Nutzung (Sekunden)")
      .setDesc(
        "Nur relevant, solange gerade Traffic läuft (siehe oben) – wie oft " +
          "währenddessen maximal nachgefragt wird. Standard: 30 s."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.liveApiRefreshSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.liveApiRefreshSeconds =
            Number.isFinite(n) && n >= 15 ? n : DEFAULT_SETTINGS.liveApiRefreshSeconds;
          await this.plugin.saveSettings();
          this.plugin.restartLiveApiIntervalIfActive();
        })
      );

    new Setting(containerEl)
      .setName("Ruhezeit bis Polling pausiert (Sekunden)")
      .setDesc(
        "Wie lange ohne erkannte Claudian-Aktivität gewartet wird, bevor das " +
          "Polling wieder aussetzt (ein letzter Abruf für den finalen Stand " +
          "läuft dabei noch mit). Standard: 20 s."
      )
      .addText((t) =>
        t.setValue(String(this.plugin.settings.liveApiIdleStopSeconds)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.liveApiIdleStopSeconds =
            Number.isFinite(n) && n >= 5 ? n : DEFAULT_SETTINGS.liveApiIdleStopSeconds;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Fehlersuche" });

    new Setting(containerEl)
      .setName("Debug-Logging (Konsole)")
      .setDesc(
        "Schreibt ausführliche Details (Aktualisierungszyklen, gelesene Werte, " +
          "Live-API-Rohantworten) in die Entwicklerkonsole (Strg/Cmd+Shift+I → " +
          "Tab \"Console\"). Fehler werden unabhängig davon immer geloggt."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugLogging).onChange(async (v) => {
          this.plugin.settings.debugLogging = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Claude-Verzeichnis (optional)")
      .setDesc("Leer lassen für Standard ~/.claude. Nur setzen bei CLAUDE_CONFIG_DIR/portabler Installation.")
      .addText((t) =>
        t.setValue(this.plugin.settings.claudeDir).onChange(async (v) => {
          this.plugin.settings.claudeDir = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
