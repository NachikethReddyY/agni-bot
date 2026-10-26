# Agni for Mac

Native SwiftUI client for the Agni daemon. It uses the shared v2 WebSocket
protocol, stores the device token in Keychain, and keeps the interface native
to macOS: a thread sidebar, streaming conversation, and optional details
inspector.

## Build and launch

From the repository root:

```sh
bun run mac
bun run mac-app
open apps/mac/.build/Agni.app
```

`mac` compiles the Swift package. `mac-app` creates an unsigned app bundle at
`apps/mac/.build/Agni.app`, including `Info.plist` and the supplied Agni icon.
It requires macOS tools `sips` and `iconutil` to generate the icon resource.

## Connect

Start the daemon and mint a device token on the server:

```sh
bun run daemon start
bun run pair --name "This Mac"
```

In Agni, enter the server address (for example `127.0.0.1:8787` or its
Tailscale address) and the token printed by `pair`. The app saves the token in
Keychain, reconnects with exponential backoff, and requests replay/history
after reconnecting. Use the Agni menu's **Forget this device** action to remove
the saved token and pair again.

The app target supports macOS 15 and newer. `agni-probe` is a headless protocol
client for connection diagnostics.
