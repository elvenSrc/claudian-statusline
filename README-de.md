# Claudian Statusline

*[English version](README.md)*

Eigenständiges Obsidian-Sidecar-Plugin, das oberhalb des
[Claudian](https://github.com/YishenTu/claudian)-Eingabefelds (links von
"New tab"/"Chat history") eine zweizeilige Statusline einblendet:

- **Zeile 1** – 5h-/7d-Rate-Limit inkl. Reset-Zeitpunkt. Tab-unabhängig,
  gilt für den ganzen Account.
- **Zeile 2** – Kontext-% sowie In-/Out-Tokens des gerade aktiven
  Claudian-Tabs. Wechselt automatisch mit, wenn ein anderer Tab gewählt wird.

Kein Fork, kein Patch von Claudian: Das Plugin liest ausschließlich Dateien,
die Claude Code bzw. Claudian ohnehin selbst schreiben, und hängt sein
eigenes DOM-Element per `insertBefore` in Claudians Oberfläche ein. Claudian
selbst wird an keiner Stelle verändert.

## Installation

1. Diesen Ordner (`claudian-statusline/`, mit `manifest.json`, `main.js`,
   `styles.css`) komplett nach
   `<DeinVault>/.obsidian/plugins/claudian-statusline/` kopieren.
2. Obsidian neu laden (`Strg`/`Cmd` + `P` → "Reload app without saving")
   oder Obsidian einmal neu starten.
3. Einstellungen → Community-Plugins → **Claudian Statusline** aktivieren.

Kein Build-Schritt nötig – `main.js` ist bewusst als reines CommonJS ohne
Bundler geschrieben, damit "einfach kopieren" reicht.

## Deinstallation / Deaktivieren

Jederzeit folgenlos:

- **Nur ausschalten:** Einstellungen → Community-Plugins → Schalter auf Aus.
- **Ganz entfernen:** den Ordner
  `<DeinVault>/.obsidian/plugins/claudian-statusline/` löschen.

In beiden Fällen bleibt Claudian selbst unverändert – es wurde nie in
Claudians eigene Dateien geschrieben.

## Woher die Daten kommen

| Zeile | Datei | Felder |
|---|---|---|
| 5h/7d | `~/.claude/statusline-cache.json` (Pfad überschreibbar in den Plugin-Einstellungen) | `five_hour.used_percentage`/`resets_at`, `seven_day.used_percentage`/`resets_at` |
| Aktiver Tab | `<Vault>/.obsidian/plugins/realclaudian/data.json` | `tabManagerState.activeTabId`, `tabManagerState.openTabs[].conversationId` |
| Kontext-%/In | `<Vault>/.claudian/sessions/<conversationId>.meta.json` | `usage.percentage`, `usage.contextTokens`, `usage.contextWindow`, `usage.inputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens` |
| Out | `~/.claude/projects/<sanitizedVaultPath>/<sessionId>.jsonl` (letzte Assistant-Message) | `message.usage.output_tokens` |

`sanitizedVaultPath` entspricht Claude Codes eigenem Schema: der absolute
Vault-Pfad mit allen Nicht-alphanumerischen Zeichen durch `-` ersetzt (genau
wie bei den regulären `claude`-CLI-Projektordnern).

Alle Zugriffe sind lesend, alle mit `try/catch` abgesichert. Fehlt eine
Datei (z. B. weil noch nie eine Nachricht in diesem Tab gesendet wurde),
erscheint ein `–` statt eines Fehlers.

## Wie die Aktualisierung funktioniert

Hybrid aus Push und Poll, beides rein lesend:

1. **Primär: `fs.watch` (inotify unter Linux).** Das Plugin beobachtet
   gezielt die relevanten Verzeichnisse (`~/.claude`, `.obsidian/plugins/
   realclaudian`, `.claudian/sessions`, `~/.claude/projects/<Vault>`) und
   löst bei jeder Änderung (debounct, 200 ms) sofort eine Neu-Anzeige aus –
   also praktisch in Echtzeit, sobald Claude Code/Claudian eine der Dateien
   schreibt.
2. **Fallback: Timer** (Einstellung "Aktualisierungsintervall", Standard 5 s).
   Greift, falls `fs.watch` auf einem Verzeichnis (noch) nicht funktioniert,
   z. B. weil es beim Plugin-Start noch nicht existierte (etwa `.claudian/
   sessions/`, solange noch nie eine Nachricht gesendet wurde) – der Timer
   versucht dann bei jedem Tick auch, fehlende Watcher nachzurüsten.

Kein API-Call nötig: Alle Werte kommen aus Dateien, die Claude Code bzw.
Claudian ohnehin selbst auf die Platte schreiben (siehe Tabelle oben).

**Wichtig zu wissen:** Claudian selbst schreibt das `usage`-Feld in die
`*.meta.json` erst, **nachdem** eine Antwort vollständig abgeschlossen ist –
nicht laufend während der Generierung. Solange das noch aussteht (frischer
Tab, oder eine Antwort läuft gerade), zeigt Zeile 2 stattdessen einen
**Live-Fallback**: `Ctx: ~X (live, vorläufig) · In: … · Out: …`, direkt aus
dem JSONL-Transkript der Session berechnet (dieselbe Quelle, aus der auch
`claude_tools/statusline-viewer-py` liest) – ohne %-Angabe, da das
Kontextfenster dafür noch nicht bekannt ist. Sobald Claudian die Antwort
abschließt und `usage` schreibt, springt die Zeile automatisch auf die
vollständige Ansicht mit %-Wert um. Nur bei einem wirklich leeren Tab ganz
ohne jede Aktivität bleibt "Ctx: – (noch keine Nutzungsdaten für diesen Tab)"
stehen.

## Live-Rate-Limit-Abfrage (experimentell, standardmäßig aus)

Normalerweise stammt Zeile 1 aus `~/.claude/statusline-cache.json` – diese
Datei wird aber nur aktualisiert, wenn irgendwo eine echte `claude`-
Terminal-CLI-Session läuft (die eigene Statusline-Logik der CLI schreibt
sie). Claudians `sdk-ts`-Sessions lösen das nicht aus – selbst bei aktivem
Traffic bleibt die Datei unverändert.

Optional kann das Plugin die 5h-/7d-Werte stattdessen **direkt live**
abfragen, über einen von Anthropic **nicht offiziell dokumentierten**
Endpunkt (`api.anthropic.com/api/oauth/usage`), mit dem ohnehin lokal
gespeicherten OAuth-Token aus `~/.claude/.credentials.json` (derselbe Token,
den Claude Code/Claudian selbst zum Login nutzen). Das kostet keine Tokens –
es ist eine reine Abfrage, keine Generation.

- **Standardmäßig deaktiviert.** In den Einstellungen unter "Live-Rate-
  Limit-Abfrage" einschaltbar.
- **Inoffiziell = kann jederzeit ohne Ankündigung brechen.** Bei Fehlern
  (Endpunkt nicht erreichbar, Token fehlt, Format geändert) fällt die
  Statusline automatisch und stillschweigend auf die Datei-basierten Werte
  zurück – kein Absturz, kein hartes Fehlverhalten.
- **Aktivitätsgetrieben statt Dauerpolling.** Es wird nicht permanent im
  Sekundentakt angefragt, sondern nur, während gerade wirklich Claude-Traffic
  läuft – egal ob über **Claudian in diesem Vault** (Schreibzugriffe auf
  `.claudian/sessions` bzw. das Transkript-Verzeichnis) oder über eine
  **`claude`-Terminal-CLI-Session irgendwo auf dieser Maschine**
  (Schreibzugriffe auf `~/.claude` selbst, wo `statusline-cache.json` bei
  jeder eigenen CLI-Statusline-Aktualisierung berührt wird, sowie auf
  `~/.claude/sessions/`, die globale, prozessweite Registry aller laufenden
  Claude-Code-Sessions, unabhängig von Projekt oder Vault):
  1. Erste Aktivität → sofortiger Abruf, danach Polling im konfigurierten
     Intervall (Standard: 30 s), solange weitere Aktivität reinkommt.
  2. Bleibt für die konfigurierte Ruhezeit (Standard: 20 s) keine weitere
     Aktivität aus (Turn vermutlich abgeschlossen) → ein letzter Abruf für
     den finalen Stand, danach pausiert das Polling wieder komplett, bis
     erneut Traffic auftritt.
  Im Leerlauf bleiben die zuletzt abgerufenen Werte einfach stehen – das ist
  unproblematisch, da sich das Rate-Limit ohne eigene Nutzung ohnehin nicht
  ändert. Zusätzlich zur Aktivierung gibt es einen einmaligen Initial-Abruf
  beim Einschalten bzw. Plugin-Start, damit sofort etwas angezeigt wird.
- Beide Intervalle (Poll-Intervall während Aktivität, Ruhezeit bis Pause)
  sind in den Einstellungen konfigurierbar.
- Ein kleiner Tooltip auf Zeile 1 zeigt an, ob gerade live oder per
  Datei-Fallback abgefragt wird; bei einem Live-Fehler erscheint zusätzlich
  ein sichtbares "⚠" direkt in der Zeile.
- Antwortet der Endpunkt mit HTTP 200, aber in einem unerwarteten Format
  (z. B. weil sich der inoffizielle Endpunkt geändert hat), wird das **nicht**
  als gültiger Wert übernommen, sondern ebenfalls als Fehler behandelt – so
  bleibt die Zeile nie dauerhaft leer/`–`, sondern zeigt die funktionierenden
  Datei-basierten Werte.
- Der Prozentwert steht in der echten Antwort unter `utilization` (0–100),
  nicht unter `used_percentage` wie ursprünglich angenommen – per
  Debug-Logging an einer echten Antwort verifiziert. Beide Feldnamen werden
  unterstützt.

## Einstellungen

- 5h-/7d-Zeile bzw. Kontext-Zeile einzeln ein-/ausblendbar
- Aktualisierungsintervall (Standard: 5 s)
- **Schriftgröße** (9–20 px, Standard: 11 px) – wirkt auf beide Zeilen
- **Fortschrittsbalken für %-Werte** (5h, 7d, Ctx): "Aus" (nur Text, Standard),
  "Zusätzlich zur %-Zahl" oder "Statt %-Zahl". Balkenfarbe wechselt
  automatisch Grün → Orange → Rot anhand zweier konfigurierbarer
  Schwellwerte (Standard: 70 % / 90 %)
- Claude-Verzeichnis überschreibbar (bei `CLAUDE_CONFIG_DIR`/portabler
  Installation abweichend von `~/.claude`)
- **Debug-Logging** (Konsole): schreibt Aktualisierungszyklen, gelesene Werte
  und Live-API-Rohantworten in die Entwicklerkonsole
  (`Strg`/`Cmd`+`Shift`+`I` → Tab "Console"). Fehler werden unabhängig davon
  immer geloggt. Standardmäßig aus, hilfreich bei "aktualisiert sich nicht".

## Bekannte Einschränkungen

- **Nur Desktop** (`isDesktopOnly: true`), da Node-`fs`/`path`/`os`
  verwendet werden – wie Claudian selbst auch.
- **Mehrere gleichzeitig offene Claudian-Panes:** `tabManagerState` in
  Claudians `data.json` ist ein einziger, globaler Zustand. Bei mehreren
  parallel geöffneten Claudian-Ansichten zeigt Zeile 2 überall den zuletzt
  fokussierten Tab, nicht zwingend den lokal in jeder einzelnen Ansicht
  sichtbaren.
- **Update-Risiko (bewusst in Kauf genommen):** Ändert ein Claudian-Update
  die CSS-Klassen `.claudian-input-nav-content`/`.claudian-tab-bar-container`
  oder das Format von `data.json`/`*.meta.json`, bleibt die Statusline
  einfach leer/unsichtbar statt zu crashen – dann hier kurz nachschauen, ob
  sich die Selektoren/Felder geändert haben, und `main.js` entsprechend
  anpassen.
- **Windows: ungetestet.** `fs.watch` selbst ist plattformneutral (nutzt
  unter Windows intern `ReadDirectoryChangesW` statt inotify) und sollte
  ohne Anpassung funktionieren. Unsicher ist nur, ob `resolveProjectDir()`
  (Ermittlung von `~/.claude/projects/<sanitizerVaultPfad>/`) exakt
  Claude Codes eigene Sanitisierung auf Windows-Pfaden (Laufwerksbuchstabe,
  Backslashes) trifft – der Code probiert deshalb mehrere plausible
  Varianten durch, statt sich auf eine zu verlassen (siehe Kommentar dort).
  Sollte trotzdem keine passen, bleiben nur "Out" (Zeile 2) und der
  Live-Kontext-Fallback leer (`–`) – Zeile 1 und der Rest von Zeile 2 sind
  davon unabhängig und liefen in dem Fall trotzdem normal weiter. Mit
  aktiviertem Debug-Logging (Einstellungen) werden alle versuchten
  Pfad-Kandidaten in die Konsole geloggt.
