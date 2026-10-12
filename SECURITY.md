# Security Policy

## Supported Versions

Security fixes are released for the latest published version of Agent Bot.

## Interactive Terminal Trust Boundary

Terminal management cards in the original command conversation/topic can close their associated Shell without browser credentials. They validate the current owner, exact card and action token. Eight-character URL tokens share `/terminal/<token>` and identify a stored command or terminal but grant no execution access; the server selects behavior, and retired recovery tokens stay reserved so they never become new-shell links; do not shorten the independent browser keys or approval tokens. Reopen links identify a terminal but grant no access: recovery requires fresh code approval, rotates browser authorization and revokes old access. Denying a recovery request leaves the original terminal unaffected; ended terminals cannot be recovered. Never approve recovery on the owner's behalf.

The browser terminal executes arbitrary commands as the Agent Bot OS user, outside Agent sandbox settings. Disable it with `terminal.enabled: false` or disable `fileViewer`. Terminal and Preview share `fileViewer` networking and the same origin, but not authorization. Raw files have a no-script response sandbox; rendered HTML has an opaque-origin sandbox without same-origin privilege or network requests. Do not remove those boundaries or serve other arbitrary scripts in this origin. Protect profile files/signing secrets with local user access controls.

HTTP terminals are supported for trusted LAN use; traffic is unencrypted. Network interception/tampering can compromise terminal traffic and credentials; owner approval is not transport encryption. Use HTTPS on untrusted networks or the Internet, preserve Host/Origin and proxy WebSocket upgrades. Never log terminal credentials or traffic.

Every browser session needs matching-code owner approval in the original Feishu command conversation/topic. Group members may see the card and verification code but cannot authorize: current owner, exact card ID and action token are checked independently of the delivery destination. A launch link or Preview token alone cannot execute commands. Never approve unsolicited requests or log/share browser credentials. Keys live in sessionStorage, not URLs; access to that browser tab or OS account is inside the trust boundary. Shells can read host files and other environment credentials even though internal Feishu/Agent Bot variables are filtered. Shell profiles also execute as that user.

Disconnecting retains the Shell for three minutes; a successful authenticated reconnection cancels this deadline and restarts thirty idle minutes, but command output does not extend the disconnect deadline. A connected foreground page with fresh visibility heartbeats prevents idle closure; hiding it starts thirty minutes of input/output inactivity. Either timeout closes it. Explicit close, the eight-hour absolute limit and service shutdown still end it. Detached processes may survive. Safe restart waits for active terminals; forced restart interrupts them.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability.

Report it through [GitHub private vulnerability reporting](https://github.com/keyou/agent-bot/security/advisories/new). Include the affected version, reproduction steps, impact, and any suggested mitigation.

The project will acknowledge the report, investigate it, and coordinate disclosure and a fixed release when appropriate.
