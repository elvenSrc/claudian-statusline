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
die Claude Code (für Zeile 1: dein eigener `statusLine`-Befehl, siehe
[Voraussetzung für Zeile 1](#voraussetzung-für-zeile-1-ein-statusline-befehl))
bzw. Claudian ohnehin selbst schreiben, und hängt sein
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
| 5h/7d | `~/.claude/statusline-cache.json` (geschrieben von deinem eigenen `statusLine`-Befehl, siehe [unten](#voraussetzung-für-zeile-1-ein-statusline-befehl); Pfad überschreibbar in den Plugin-Einstellungen) | `five_hour.used_percentage`/`resets_at`, `seven_day.used_percentage`/`resets_at` |
| Aktiver Tab | `<Vault>/.obsidian/plugins/realclaudian/data.json` | `tabManagerState.activeTabId`, `tabManagerState.openTabs[].conversationId` |
| Kontext-%/In | `<Vault>/.claudian/sessions/<conversationId>.meta.json` **oder** (ab Claudian 2.2.5, neue Sessions) `<Vault>/.claudian/sessions/devices/device-<Hash>/<conversationId>.meta.json` | `usage.percentage`, `usage.contextTokens`, `usage.contextWindow`, `usage.inputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens` |
| Out | `~/.claude/projects/<sanitizedVaultPath>/<sessionId>.jsonl` (letzte Assistant-Message) | `message.usage.output_tokens` |

`sanitizedVaultPath` entspricht Claude Codes eigenem Schema: der absolute
Vault-Pfad mit allen Nicht-alphanumerischen Zeichen durch `-` ersetzt (genau
wie bei den regulären `claude`-CLI-Projektordnern).

Alle Zugriffe sind lesend, alle mit `try/catch` abgesichert. Fehlt eine
Datei (z. B. weil noch nie eine Nachricht in diesem Tab gesendet wurde),
erscheint ein `–` statt eines Fehlers.

## Voraussetzung für Zeile 1: ein `statusLine`-Befehl

Claude Code schreibt `~/.claude/statusline-cache.json` **nicht** von selbst.
Was es tut: Bei jeder Statusline-Aktualisierung einer interaktiven `claude`-
Terminal-Session übergibt es ein JSON-Objekt per stdin an den Befehl, der in
`~/.claude/settings.json` als `statusLine` eingetragen ist – und dieses JSON
enthält `rate_limits.five_hour` und `rate_limits.seven_day`. Zeile 1 braucht
also einen `statusLine`-Befehl, der diese Werte in die Cache-Datei schreibt.
Ohne ihn zeigt Zeile 1 nur `5h: – · 7d: – (keine statusline-cache.json
gefunden)`.

Das muss **einmal pro Rechner** eingerichtet werden (`settings.json` ist
lokal) – entweder per `/statusline` (Variante A) oder von Hand mit einem der
Skripte weiter unten (Variante B).

### Variante A: `/statusline` (Kopiervorlage)

Als eine einzige Zeile ins Claude-Code-Terminal einfügen (den ersten Satz
nach Belieben anpassen – er bestimmt nur, was du selbst im Terminal siehst):

```text
/statusline Zeige die Modellbezeichnung an. Zusätzlich muss das Skript bei jedem Aufruf rate_limits.five_hour und rate_limits.seven_day aus dem stdin-JSON nach ~/.claude/statusline-cache.json schreiben, und zwar auf OBERSTER EBENE (nicht unter rate_limits verschachtelt), exakt in dieser Form: {"five_hour":{"used_percentage":<Zahl>,"resets_at":<Unix-Epoch-Sekunden>},"seven_day":{"used_percentage":<Zahl>,"resets_at":<Unix-Epoch-Sekunden>}}. Nur Fenster aufnehmen, bei denen used_percentage vorhanden ist, und die Datei gar nicht schreiben, wenn keines vorhanden ist (vorhandene Werte nie mit leeren überschreiben). Erst in eine Temp-Datei im selben Verzeichnis schreiben, dann über die Zieldatei umbenennen. UTF-8 ohne BOM. Unter Windows ein PowerShell-Skript (ohne Node/jq), unter Linux/macOS ein bash-Skript mit jq.
```

Danach im Terminal eine `claude`-Session starten, eine Nachricht senden und
prüfen, ob `~/.claude/statusline-cache.json` dem unten gezeigten Format
entspricht. Da `/statusline` sein Skript jedes Mal neu erzeugt, kann das
Ergebnis variieren – passt es nicht, Variante B verwenden.

### Benötigtes Format (für beide Varianten)

Erwartetes Format – `five_hour`/`seven_day` **auf oberster Ebene** (nicht
unter `rate_limits` verschachtelt), `resets_at` in Unix-Epoch-Sekunden, genau
so, wie Claude Code es liefert:

```json
{"five_hour":{"used_percentage":28,"resets_at":1789299000},"seven_day":{"used_percentage":70,"resets_at":1789293600}}
```

Worauf das Skript achten sollte:

- **Nur `five_hour`/`seven_day` schreiben**, nicht das komplette stdin-JSON –
  das Plugin liest die Werte auf oberster Ebene.
- **Nur schreiben, wenn Werte vorhanden sind.** `rate_limits` fehlt bzw. ist
  `null` direkt nach dem Start einer Session (vor der ersten API-Antwort) und
  bei API-Key-/Bedrock-/Vertex-Anmeldung. Wer ohne Prüfung schreibt, lässt
  eine frische Session gute Werte mit leeren überschreiben.
- **Erst in eine Temp-Datei schreiben, dann umbenennen**, damit das Plugin nie
  eine halb geschriebene Datei liest.
- **Kein UTF-8-BOM** – `JSON.parse` lehnt es ab (relevant bei PowerShell).

### Variante B: Skript von Hand

**Linux/macOS** (bash + `jq`), z. B. `~/.claude/statusline.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
cache="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-cache.json"
rl=$(jq -c '(.rate_limits // {}) | {five_hour, seven_day}
  | with_entries(select(.value.used_percentage != null)
  | .value |= {used_percentage, resets_at})' <<<"$input")
if [ -n "$rl" ] && [ "$rl" != "{}" ]; then
  tmp="$cache.$$.tmp"
  printf '%s' "$rl" > "$tmp" && mv -f "$tmp" "$cache"
fi
jq -r '.model.display_name // "Claude"' <<<"$input"   # sichtbare Statusline
```

```json
"statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" }
```

**Windows** (PowerShell 5.1, ohne Node/`jq`), z. B.
`%USERPROFILE%\.claude\statusline.ps1`:

```powershell
$d = [Console]::In.ReadToEnd() | ConvertFrom-Json
$dir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$cache = [ordered]@{}
foreach ($k in 'five_hour', 'seven_day') {
  $w = $d.rate_limits.$k
  if ($w -and $null -ne $w.used_percentage) {
    $cache[$k] = [ordered]@{ used_percentage = $w.used_percentage; resets_at = $w.resets_at }
  }
}
if ($cache.Count) {
  $target = Join-Path $dir 'statusline-cache.json'
  $tmp = "$target.$PID.tmp"
  [IO.File]::WriteAllText($tmp, ($cache | ConvertTo-Json -Depth 3 -Compress), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $target -Force
}
Write-Output $d.model.display_name   # sichtbare Statusline
```

```json
"statusLine": { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<du>/.claude/statusline.ps1" }
```

Die sichtbare Statusline im Terminal lässt sich beliebig erweitern – nur die
Cache-Datei muss dieses Format behalten.

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

Dieser Live-Fallback greift dabei nicht nur beim allerersten Turn eines
frischen Tabs, sondern auch bei **jedem weiteren** Turn (und direkt nach
einem `/compact`): Erkannt wird das über einen Zeitstempel-Vergleich – ist
das JSONL-Transkript neuer als die zuletzt geschriebene `*.meta.json`, gilt
deren `usage`-Feld als veraltet, und Zeile 2 rechnet so lange live nach, bis
Claudian nach Abschluss des aktuellen Turns eine neue `usage` schreibt. Ohne
diese Erkennung würde Zeile 2 ab dem zweiten Turn in einem Tab bis zum
jeweiligen Abschluss stur die (unter Umständen längst überholten) Werte des
vorigen Turns zeigen.

## Live-Rate-Limit-Abfrage (experimentell, standardmäßig aus)

Normalerweise stammt Zeile 1 aus `~/.claude/statusline-cache.json` – diese
Datei wird aber nur aktualisiert, wenn irgendwo eine echte `claude`-
Terminal-CLI-Session läuft, denn nur diese führt deinen `statusLine`-Befehl
aus (siehe [Voraussetzung für Zeile 1](#voraussetzung-für-zeile-1-ein-statusline-befehl)).
Claudians `sdk-ts`-Sessions lösen ihn nicht aus – selbst bei aktivem
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
  (Schreibzugriffe auf `~/.claude` selbst, wo dein `statusLine`-Befehl
  `statusline-cache.json` bei jeder CLI-Statusline-Aktualisierung
  aktualisiert, sowie auf
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
  automatisch Grün → Orange → Rot.
  - 5h/7d nutzen zwei gemeinsame, konfigurierbare %-Schwellwerte (Standard:
    70 % / 90 %).
  - **Ctx hat eine eigene, unabhängige Farbeinstellung**: wahlweise
    "Prozent" (eigene %-Schwellwerte, analog zu 5h/7d) oder "Tokenzahl"
    (Schwellwerte als absolute Anzahl Kontext-Tokens, Standard: 120.000 /
    170.000 – Eingabe auch als Kurzschreibweise möglich, z. B. `120k`, `1M`
    oder `0,17M`, mit Komma oder Punkt als Dezimaltrennzeichen). Tokenbasiert
    ist besonders im **"live, vorläufig"-Fallback**
    nützlich: Dort ist noch kein %-Wert bekannt (Claudian liefert das
    Kontextfenster erst nach Turn-Abschluss), sodass sich der Balken nur mit
    Tokenbasis überhaupt einfärben und anzeigen lässt – bei Farbbasis
    "Prozent" bleibt er in diesem Zustand weiterhin aus. Bei Farbbasis
    "Tokenzahl" wird zudem die **Balkenlänge selbst** auf den Rot-Schwellwert
    normiert (der Rot-Schwellwert entspricht also "100 % Balkenlänge"), statt
    auf das tatsächliche, meist deutlich größere Kontextfenster – so wird der
    selbst gesetzte Warnbereich auch optisch sichtbar ausgefüllt, statt dass
    der Balken erst nahe der echten ~200k-Grenze voll wirkt. Gilt sowohl im
    normalen als auch im "live, vorläufig"-Zustand.
  - Zusätzlich, ebenfalls nur bei Farbbasis "Tokenzahl": **"Ctx-%-Anzeige auf
    eigenen Rot-Schwellwert normieren"** (Standard: aus). Damit wird nicht
    nur die Balken*länge*, sondern auch die angezeigte %-*Zahl* auf den
    eigenen Rot-Schwellwert bezogen (100 % = eigener Warnwert) – anders als
    die Balkenlänge aber bewusst **ohne Deckelung bei 100 %**: Wird der
    eigene Schwellwert überschritten, steigt die Anzeige entsprechend darüber
    (z. B. 118 %), sodass sofort sichtbar ist, um wie viel der selbst
    gesetzte, sicher geglaubte Rahmen bereits überschritten wurde. Der echte,
    von Claudian gemeldete %-Wert bleibt per Tooltip auf der Zeile abrufbar.
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
  anpassen. Bereits einmal eingetreten und behoben (siehe `findMetaFilePath()`
  in `main.js`): Ab Claudian 2.2.5 landet die `*.meta.json` neuer Sessions
  geräte-gebunden unter `.claudian/sessions/devices/device-<Hash>/` statt
  flach unter `.claudian/sessions/` – seit v1.9.0 werden beide Orte
  unterstützt (neuer zuerst, alter als Fallback für ältere Sessions).
- **Windows: nur teilweise getestet.** Zeile 1 funktioniert nachweislich
  unter Windows 10, sobald ein `statusLine`-Befehl die Cache-Datei schreibt
  (PowerShell-Skript, siehe
  [Voraussetzung für Zeile 1](#voraussetzung-für-zeile-1-ein-statusline-befehl)) –
  ohne ihn erscheint "keine statusline-cache.json gefunden", was kein
  Windows-Fehler ist. Der Rest ist ungetestet. `fs.watch` selbst ist plattformneutral (nutzt
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
