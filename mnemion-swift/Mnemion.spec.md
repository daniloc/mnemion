# Mnemion for Apple platforms

The native client: SwiftUI surfaces over MnemionKit, a pure client of the hive's owner API with no replica, where every rule about the data is the hive's declaration and never this client's guess.

## trust levels
- owner-session: Code running with the signed-in member's OAuth bearer: the app, its share extension and its App Intents.
- hive: The worker, the single source of truth, reached over `/api/*` and `/ws`.

## entrances
- app: The system starts the app.
  handler: MnemionApp
  trust: owner-session
- capture note intent: Siri, Shortcuts, Spotlight or the Action button run the capture intent.
  handler: CaptureNoteIntent
  trust: owner-session
- share sheet: The host app loads the share extension's principal class.
  handler: ShareViewController
  trust: owner-session
- app shortcuts: The system reads the shortcuts the app offers (their phrases and intents) when the app is installed.
  handler: MnemionShortcuts
  trust: owner-session
