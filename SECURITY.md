# Security Policy

## Supported Versions

Security fixes are released for the latest published version of Agent Bot.

## Interactive Terminal Trust Boundary

Terminal management cards in the original command conversation/topic can close their associated Shell without browser credentials. They validate the current owner, exact card and action token. Eight-character URL tokens share `/terminal/<token>`; the server selects command or recovery behavior. Command links require password login before starting a Shell. Recovery links grant passwordless reattachment only while their original Shell is running, rotate browser authorization and revoke old access. Keep these links private. Retired recovery tokens stay reserved so they never become new-shell links; do not shorten the independent browser keys or card action tokens. Ended terminals cannot be recovered.

The browser terminal executes arbitrary commands as the Agent Bot OS user, outside Agent sandbox settings. Disable it with `terminal.enabled: false` or disable `fileViewer`. Terminal and Preview share `fileViewer` networking and the same origin, but not authorization. Raw files have a no-script response sandbox; rendered HTML has an opaque-origin sandbox without same-origin privilege or network requests. Do not remove those boundaries or serve other arbitrary scripts in this origin. Protect profile files/signing secrets with local user access controls.

HTTP terminals are supported for trusted LAN use; traffic is unencrypted. Network interception/tampering can compromise terminal traffic and credentials; password login is not transport encryption. Use HTTPS on untrusted networks or the Internet, preserve Host/Origin and proxy WebSocket upgrades. Never log terminal credentials or traffic.

New or unstarted Shells require the terminal password, configurable through owner-only `/settings` > Advanced. The public default is `123456`: while it remains configured, the login page prefills it and automatically connects after five seconds. Anyone with a command link can therefore start a Shell under the default configuration; set a strong custom password before exposing the service. Custom passwords are never sent to the page or prefilled. Editing or leaving the login page cancels the countdown; automatic login still uses server-side authentication, rate limits and restart protection. Saved grants and running-Shell recovery do not wait for the countdown. Browser keys live in sessionStorage, not URLs; access to that browser tab or OS account is inside the trust boundary. Shells can read host files and other environment credentials even though internal Feishu/Agent Bot variables are filtered. Shell profiles also execute as that user.

Disconnecting retains the Shell for thirty minutes; a successful authenticated reconnection cancels this deadline and restarts thirty idle minutes, but command output does not extend the disconnect deadline. A connected foreground page with fresh visibility heartbeats prevents idle closure; hiding it starts thirty minutes of input/output inactivity. Either timeout closes it. Explicit close, the eight-hour absolute limit and service shutdown still end it. Detached processes may survive. Safe restart waits for active terminals; forced restart interrupts them.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability.

Report it through [GitHub private vulnerability reporting](https://github.com/keyou/agent-bot/security/advisories/new). Include the affected version, reproduction steps, impact, and any suggested mitigation.

The project will acknowledge the report, investigate it, and coordinate disclosure and a fixed release when appropriate.
