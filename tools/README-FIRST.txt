SDG Connection Test - Easy Run Bundle
======================================

WHAT THIS DOES
  Tests whether your internet connection has trouble reaching the SDG
  Space Engineers test server. The test sends harmless UDP traffic that
  looks like the game's own traffic and reports back what got through.

HOW TO RUN
  1. Make sure you are connected to the network you want to test
     (the same Wi-Fi or wired connection you use to play).
  2. Double-click "Run-Test.cmd".
  3. A black window will open and run for about 3 to 4 minutes.
     Do NOT close it - it closes itself when finished.
  4. When it finishes you will see a message like:
        Report saved to: C:\Users\<you>\Desktop\sdg-test-report-...json
  5. Copy that file from your Desktop to a SDG support ticket.

REQUIREMENTS
  - Windows 10 or Windows 11, 64-bit.
  - About 100 MB of free disk space (this folder).
  - Outbound UDP allowed (most home connections; corporate firewalls
    may block the test).

TROUBLESHOOTING
  - "Windows protected your PC": click "More info", then "Run anyway".
    The bundle is unsigned. If you want to verify it, the SHA256 of
    this download is published on the SDG release page.
  - The window closes immediately: open it from a Command Prompt
    instead so you can read any error messages, and send those to
    support.
  - "config.txt is missing": re-download the bundle.

ADVANCED
  config.txt holds the target server address. Do not edit it unless
  SDG support tells you to.

PRIVACY
  The report contains your local network test results and a redacted
  form of your public IP address (for example "1.2.3.x"). It does
  NOT contain personal files, browsing history, or anything outside
  this connection test. Full details are in docs\PRIVACY.md.
